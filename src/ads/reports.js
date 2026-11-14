// One statistics report at a time per Performance account (Ozon's limit), with no background work.
// Each account remembers the last report this process submitted: its UUID, status endpoint and
// submission time. Before the next submission (an ozon_ads_stats batch or an ozon_ads_api_call
// report, vendor reports included) the submitting call itself polls that report's status, within
// its own time budget, until Ozon reports a final state or the report is MAX_AGE old. A per-account
// queue makes "check previous → submit → record" one step, so two calls in this process cannot
// both submit; it is released in `finally`, whatever happens.
import { OzonError } from '../errors.js';
import { sleep } from '../http.js';
import { adsAccount, adsRequest, timeLimit, untilAborted } from './http.js';

// Polling every 3 s; ozon_ads_stats as a whole and each report submission get 90 s; a report
// submitted 120 s ago no longer holds the next one back.
const DEFAULT_REPORT_TIMING = Object.freeze({ pollMs: 3000, waitMs: 90_000, maxAgeMs: 120_000 });
export let reportTiming = DEFAULT_REPORT_TIMING;
export function setReportTimingForTests(timing) {
  reportTiming = { ...DEFAULT_REPORT_TIMING, ...timing };
}

// Final states. Vendor (external traffic) reports can also end as TIMEOUT or CANCEL.
const FINISHED = new Set(['OK', 'ERROR', 'TIMEOUT', 'CANCEL']);
export const isFinished = (state) => FINISHED.has(state);

// Performance client id -> { uuid, status: { path, params }, submittedAt, finished }. A submission
// that went out without a definite answer is kept as { uuid: null, unknown: true, submittedAt }: Ozon
// may be building that report, so it holds the next one back until it is MAX_AGE old.
const lastReports = new Map();
const queues = new Map(); // Performance client id -> promise settled when the slot is free

// Per-account state between tests; nothing runs in the background, so nothing needs stopping.
export function resetReportSlots() {
  lastReports.clear();
  queues.clear();
}

// Whoever reads a report's status reports a final state here, so the next submission need not ask again.
export function observeReportStatus(uuid, state) {
  if (!isFinished(state)) return;
  const last = lastReports.get(adsAccount());
  if (last && last.uuid === String(uuid)) last.finished = true;
}

const describeLast = (last) => (last.unknown ? '上一份报表（已提交但结果未知）' : `上一份报表（UUID=${last.uuid}）`);
const seconds = (ms) => Math.max(1, Math.ceil(ms / 1000));

// The previous report may still be building: neither final nor MAX_AGE old. Only the call's own
// budget running out stops the wait with an error; the age running out lets the submission go ahead.
const budgetUsedUp = (last, ageLeft) => new OzonError(`本次调用的时间预算已用完：同一广告账号${describeLast(last)}还在生成或状态未知，`
  + `还要约 ${seconds(ageLeft)} 秒才满 ${seconds(reportTiming.maxAgeMs)} 秒的等待上限，未提交新报表；请稍后再试。`);

// Waits until the account's previous report is final or MAX_AGE old. Every status poll and every
// pause is bounded by both the call's budget and the report's remaining age: when the age runs out
// first, waiting stops and the submission goes ahead; when the budget runs out first, the caller
// fails without submitting. A failed poll is not a final state. A placeholder (result unknown) has
// no status to ask for: it is waited out, or refused at once when the budget cannot cover it.
async function previousFinished(clientId, budget) {
  const last = lastReports.get(clientId);
  while (last && !last.finished) {
    const ageLeft = last.submittedAt + reportTiming.maxAgeMs - Date.now();
    if (ageLeft <= 0) return;
    if (budget.signal?.aborted) throw budgetUsedUp(last, ageLeft);
    if (last.unknown && budget.deadline !== undefined && budget.deadline - Date.now() < ageLeft) throw budgetUsedUp(last, ageLeft);
    const age = timeLimit(ageLeft);
    const signal = budget.signal ? AbortSignal.any([budget.signal, age.signal]) : age.signal;
    try {
      if (!last.unknown) {
        const status = (await adsRequest(last.status.path, { params: { ...last.status.params, UUID: last.uuid }, signal })).data;
        if (isFinished(status?.state)) {
          last.finished = true;
          return;
        }
      }
      await sleep(last.unknown ? ageLeft : Math.min(reportTiming.pollMs, ageLeft), signal);
    } catch {
      // A failed or cut-off poll, or a pause ended early: the loop decides what happened.
    } finally {
      age.done();
    }
  }
}

// Runs `submit(signal)` as the account's next report submission and records the report it returns
// (adsRequest result or its data, with a UUID) with `status`, where its state is read. A submission
// that went out without a definite answer (error.outcomeUnknown, or no UUID) leaves a placeholder; one
// that was never sent, or was refused outright, leaves nothing. Everything, the wait for the queue
// included, stays within `budget` ({ signal, deadline }).
export async function submitReport(status, submit, budget) {
  const { signal } = budget;
  const clientId = adsAccount();
  const previous = queues.get(clientId) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  queues.set(clientId, tail);
  tail.then(() => {
    if (queues.get(clientId) === tail) queues.delete(clientId);
  });
  try {
    await untilAborted(previous, signal, '同一广告账号有其他报表正在提交，本次调用的时间预算内没轮到，未提交新报表；请稍后再试。');
    await previousFinished(clientId, budget);
    let result;
    try {
      result = await submit(signal);
    } catch (error) {
      if (error?.outcomeUnknown) lastReports.set(clientId, { uuid: null, unknown: true, submittedAt: Date.now(), finished: false });
      throw error;
    }
    const uuid = (result?.data ?? result)?.UUID;
    lastReports.set(clientId, uuid
      ? { uuid: String(uuid), status, submittedAt: Date.now(), finished: false }
      : { uuid: null, unknown: true, submittedAt: Date.now(), finished: false });
    return result;
  } finally {
    release();
  }
}
