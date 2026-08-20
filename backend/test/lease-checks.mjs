// The frame lease layer. Lives beside the worker-endpoint tests because both
// need db.js loaded in this process, and whichever suite imports it first fixes
// the database path for the whole run.
const TTL = 60_000;

export function checkLeases(db, results) {
    const JOB = 900001;
    db.createFrames(JOB, 1, 3);

    console.log('\n  Claiming a frame');

    const first = db.leaseFrame(JOB, 'worker-a', TTL);
    results.check('a claim returns a lease over the lowest pending frame',
      first?.frame === 1 && first.leasedBy === 'worker-a', JSON.stringify(first));
    results.check('the lease carries an expiry in the future',
      new Date(first.expiresAt).getTime() > Date.now(), first?.expiresAt);

    const second = db.leaseFrame(JOB, 'worker-b', TTL);
    // The whole point: worker B must not be handed the frame worker A is
    // already rendering, or both would render and upload it.
    results.check('a second worker is given the next frame, not the same one',
      second?.frame === 2 && second?.leaseId !== first?.leaseId, JSON.stringify(second));

    db.leaseFrame(JOB, 'worker-c', TTL);
    results.check('once every frame is claimed there is nothing left to give',
      db.leaseFrame(JOB, 'worker-d', TTL) === null);

    results.check('all three claims are visible as live leases',
      db.liveLeases().filter(lease => lease.jobId === JOB).length === 3,
      JSON.stringify(db.liveLeases()));

    console.log('\n  A worker that stops answering');

    const OTHER = 900002;
    db.createFrames(OTHER, 1, 1);

    const abandoned = db.leaseFrame(OTHER, 'worker-gone', -1000);
    results.check('a lease can be held with an expiry already past', abandoned !== null);
    results.check('an expired lease is not counted as live',
      db.liveLeases().every(lease => lease.jobId !== OTHER), JSON.stringify(db.liveLeases()));

    const reclaimed = db.leaseFrame(OTHER, 'worker-fresh', TTL);
    results.check('the frame goes to the next worker once the claim runs out',
      reclaimed?.frame === 1 && reclaimed.leasedBy === 'worker-fresh', JSON.stringify(reclaimed));
    results.check('and it is a new lease, not the abandoned one',
      reclaimed?.leaseId !== abandoned?.leaseId);
    // Otherwise the worker that vanished could come back and upload over the
    // frame the new worker is now rendering.
    results.check('a lease whose frame has been taken over cannot be renewed',
      db.renewLease(abandoned.leaseId, TTL) === null);

    // Checked on a frame nobody has reclaimed, so it is the expiry being
    // refused rather than the lease having been overwritten.
    const STALE = 900004;
    db.createFrames(STALE, 1, 1);
    const stale = db.leaseFrame(STALE, 'worker-slow', -1000);
    results.check('an expired lease cannot be renewed even while nobody else wants the frame',
      db.renewLease(stale.leaseId, TTL) === null, JSON.stringify(db.getLease(stale.leaseId)));

    console.log('\n  Renewing and releasing');

    const renewed = db.renewLease(reclaimed.leaseId, TTL * 2);
    results.check('a live lease can be extended',
      renewed !== null && new Date(renewed) > new Date(reclaimed.expiresAt), renewed);
    results.check('extending it records the new expiry',
      db.getLease(reclaimed.leaseId)?.expiresAt === renewed,
      JSON.stringify(db.getLease(reclaimed.leaseId)));
    results.check('renewing a lease that never existed is refused',
      db.renewLease('not-a-lease', TTL) === null);

    results.check('releasing a lease reports that it did something',
      db.releaseLease(reclaimed.leaseId) === true);
    results.check('releasing it again does nothing',
      db.releaseLease(reclaimed.leaseId) === false);
    results.check('a released frame is immediately claimable again',
      db.leaseFrame(OTHER, 'worker-next', TTL)?.frame === 1);

    console.log('\n  A frame that leaves the worker\'s hands drops its lease');

    db.markFrameDone(JOB, 1, 'frame_0001.png');
    results.check('finishing a frame keeps the claim until the worker lets go',
      db.getLease(first.leaseId)?.status === 'done',
      JSON.stringify(db.getLease(first.leaseId)));
    results.check('a finished frame is not handed to anybody else meanwhile',
      db.leaseFrame(JOB, 'worker-z', TTL)?.frame !== 1);
    results.check('and releasing it afterwards leaves nothing behind',
      db.releaseLease(first.leaseId) === true && db.getLease(first.leaseId) === null);

    db.markFrameAttemptFailed(JOB, 2, 'boom', 3);
    results.check('a failed frame that will be retried drops its lease too',
      db.getFrames(JOB).find(frame => frame.frame === 2)?.leaseId === null,
      JSON.stringify(db.getFrames(JOB).find(frame => frame.frame === 2)));
    results.check('and is claimable again by anybody',
      db.leaseFrame(JOB, 'worker-e', TTL)?.frame === 2);

    const LAST = 900003;
    db.createFrames(LAST, 1, 1);
    const exhausted = db.leaseFrame(LAST, 'worker-f', TTL);
    db.markFrameAttemptFailed(LAST, exhausted.frame, 'boom', 1);
    results.check('a frame that has run out of attempts is not handed out again',
      db.leaseFrame(LAST, 'worker-g', TTL) === null);

    db.resetFailedFrames(LAST);
    results.check('rerunning a job makes its failed frames claimable again',
      db.leaseFrame(LAST, 'worker-h', TTL)?.frame === exhausted.frame,
      JSON.stringify(db.getFrames(LAST)));

    // Reachable from the queue only for a frame recorded as done whose file has
    // since gone missing, but the claim has to go with it either way: the frame
    // is about to be handed to somebody else.
    const BACK = 900005;
    db.createFrames(BACK, 1, 1);
    const putBack = db.leaseFrame(BACK, 'worker-i', TTL);
    results.check('the frame to be put back really was claimed', putBack !== null);

    db.markFramePending(BACK, 1);
    results.check('putting a frame back to pending drops any claim on it',
      db.getLease(putBack.leaseId) === null, JSON.stringify(db.getLease(putBack.leaseId)));
    results.check('and it can be claimed again straight away',
      db.leaseFrame(BACK, 'worker-j', TTL)?.frame === 1);
}
