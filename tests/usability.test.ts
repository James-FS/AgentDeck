import { describe, expect, it, vi } from 'vitest';
import { createRefreshQueue } from '../apps/web/src/refresh-queue';
import { boundedLineDiff } from '../apps/web/src/line-diff';

describe('bounded comparison and refresh scheduling', () => {
  it('limits both character and line work while retaining additions and deletions', () => {
    expect(boundedLineDiff('a\nb','a\nc\nd')).toEqual([
      {left:'a',right:'a',changed:false},{left:'b',right:'c',changed:true},{left:'',right:'d',changed:true},
    ]);
    expect(boundedLineDiff('\n'.repeat(30_000), 'x')).toHaveLength(2000);
    expect(boundedLineDiff('a'.repeat(90_000), '')[0]?.left).toHaveLength(20_000);
  });
  it('reads a pending event even when the in-flight request fails', async () => {
    let reject!: (reason:Error)=>void;
    const run=vi.fn().mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;})).mockResolvedValue(undefined);
    const refresh=createRefreshQueue(run); const pending=refresh(); refresh();
    reject(new Error('older request failed')); await pending;
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('serializes requests and retains events and metadata requests received during refresh', async () => {
    let finish!: () => void;
    const run = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve=>{finish=resolve;})).mockResolvedValue(undefined);
    const refresh = createRefreshQueue(run);
    const first = refresh();
    const second = refresh(true);
    refresh(); refresh();
    expect(run).toHaveBeenCalledTimes(1);
    finish(); await Promise.all([first,second]);
    expect(run.mock.calls).toEqual([[false],[true]]);
    await refresh(); expect(run).toHaveBeenCalledTimes(3);
  });
});
