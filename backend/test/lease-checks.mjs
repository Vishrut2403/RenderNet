// The frame lease layer. Lives beside the worker-endpoint tests because both
// need db.js loaded in this process, and whichever suite imports it first fixes
// the database path for the whole run.
const TTL = 60_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function checkLeases(db, results) {
    const one = (jobId, workerId, ttl = TTL) => db.leaseFrames(jobId, workerId, ttl, 1);

    const JOB = 900001;
    db.createFrames(JOB, 1, 3);

    console.log('\n  Claiming a frame');

    const first = one(JOB, 'worker-a');
    results.check('a claim returns a lease over the lowest pending frame',
      first?.frames[0] === 1 && first.leasedBy === 'worker-a', JSON.stringify(first));
    results.check('the lease carries an expiry in the future',
      new Date(first.expiresAt).getTime() > Date.now(), first?.expiresAt);

    const second = one(JOB, 'worker-b');
    // The whole point: worker B must not be handed the frame worker A is
    // already rendering, or both would render and upload it.
    results.check('a second worker is given the next frame, not the same one',
      second?.frames[0] === 2 && second?.leaseId !== first?.leaseId, JSON.stringify(second));

    one(JOB, 'worker-c');
    results.check('once every frame is claimed there is nothing left to give',
      one(JOB, 'worker-d') === null);

    results.check('all three claims are visible as live leases',
      db.liveLeases().filter(lease => lease.jobId === JOB).length === 3,
      JSON.stringify(db.liveLeases()));

    console.log('\n  Claiming a span of frames at once');

    const SPAN = 900006;
    db.createFrames(SPAN, 1, 10);

    const span = db.leaseFrames(SPAN, 'worker-span', TTL, 4);
    results.check('a claim for several frames returns them under one lease',
      span?.frames.join(',') === '1,2,3,4', JSON.stringify(span));
    results.check('every frame in the span carries that one lease id',
      db.getFrames(SPAN).filter(frame => frame.leaseId === span.leaseId).length === 4);

    const after = db.leaseFrames(SPAN, 'worker-after', TTL, 4);
    results.check('the next worker gets the frames beyond the span',
      after?.frames.join(',') === '5,6,7,8', JSON.stringify(after));

    const rest = db.leaseFrames(SPAN, 'worker-rest', TTL, 4);
    results.check('a span asking for more than is left gets what there is',
      rest?.frames.join(',') === '9,10', JSON.stringify(rest));

    const spanRenewed = db.renewLease(span.leaseId, TTL * 2);
    results.check('renewing a span extends every frame in it',
      db.getFrames(SPAN)
        .filter(frame => frame.leaseId === span.leaseId)
        .every(frame => frame.leaseExpiresAt === spanRenewed), spanRenewed);

    db.releaseLease(span.leaseId);
    results.check('releasing a span frees all of its frames at once',
      db.getFrames(SPAN).filter(frame => frame.leaseId === span.leaseId).length === 0);
    results.check('and they go back out in one piece',
      db.leaseFrames(SPAN, 'worker-again', TTL, 4)?.frames.join(',') === '1,2,3,4');

    console.log('\n  What a frame of a span is timed at');

    // Every frame of a claim is stamped when the claim is taken, but Blender
    // works through them one after another: a frame really began when the one
    // before it finished. Timing from the claim would charge each frame for the
    // whole span so far, and the estimates read straight off these numbers.
    const TIMED = 900007;
    const PAUSE = 150;
    db.createFrames(TIMED, 1, 3);

    const timed = db.leaseFrames(TIMED, 'worker-timed', TTL, 3);

    for (const frame of timed.frames) {
      await sleep(PAUSE);
      db.markFrameDone(TIMED, frame, `frame_${frame}.png`);
    }

    const measured = db.getFrames(TIMED).map(frame => frame.durationMs);

    results.check('each frame is timed from when it started, not from when the span was claimed',
      measured.every(each => each < PAUSE * 2), measured.join(','));

    console.log('\n  A worker that stops answering');

    const OTHER = 900002;
    db.createFrames(OTHER, 1, 1);

    const abandoned = one(OTHER, 'worker-gone', -1000);
    results.check('a lease can be held with an expiry already past', abandoned !== null);
    results.check('an expired lease is not counted as live',
      db.liveLeases().every(lease => lease.jobId !== OTHER), JSON.stringify(db.liveLeases()));

    const reclaimed = one(OTHER, 'worker-fresh');
    results.check('the frame goes to the next worker once the claim runs out',
      reclaimed?.frames[0] === 1 && reclaimed.leasedBy === 'worker-fresh',
      JSON.stringify(reclaimed));
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
    const stale = one(STALE, 'worker-slow', -1000);
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
      one(OTHER, 'worker-next')?.frames[0] === 1);

    console.log('\n  A frame that leaves the worker\'s hands drops its lease');

    db.markFrameDone(JOB, 1, 'frame_0001.png');
    results.check('finishing a frame keeps the claim until the worker lets go',
      db.getLease(first.leaseId)?.frames.includes(1) === true
        && db.getFrames(JOB).find(frame => frame.frame === 1)?.status === 'done',
      JSON.stringify(db.getLease(first.leaseId)));
    results.check('a finished frame is not handed to anybody else meanwhile',
      one(JOB, 'worker-z')?.frames[0] !== 1);
    results.check('and releasing it afterwards leaves nothing behind',
      db.releaseLease(first.leaseId) === true && db.getLease(first.leaseId) === null);

    db.markFrameAttemptFailed(JOB, 2, 'boom', 3);
    results.check('a failed frame that will be retried drops its lease too',
      db.getFrames(JOB).find(frame => frame.frame === 2)?.leaseId === null,
      JSON.stringify(db.getFrames(JOB).find(frame => frame.frame === 2)));
    results.check('and is claimable again by anybody',
      one(JOB, 'worker-e')?.frames[0] === 2);

    const LAST = 900003;
    db.createFrames(LAST, 1, 1);
    const exhausted = one(LAST, 'worker-f');
    db.markFrameAttemptFailed(LAST, exhausted.frames[0], 'boom', 1);
    results.check('a frame that has run out of attempts is not handed out again',
      one(LAST, 'worker-g') === null);

    db.resetFailedFrames(LAST);
    results.check('rerunning a job makes its failed frames claimable again',
      one(LAST, 'worker-h')?.frames[0] === exhausted.frames[0],
      JSON.stringify(db.getFrames(LAST)));

    // Reachable from the queue only for a frame recorded as done whose file has
    // since gone missing, but the claim has to go with it either way: the frame
    // is about to be handed to somebody else.
    const BACK = 900005;
    db.createFrames(BACK, 1, 1);
    const putBack = one(BACK, 'worker-i');
    results.check('the frame to be put back really was claimed', putBack !== null);

    db.markFramePending(BACK, 1);
    results.check('putting a frame back to pending drops any claim on it',
      db.getLease(putBack.leaseId) === null, JSON.stringify(db.getLease(putBack.leaseId)));
    results.check('and it can be claimed again straight away',
      one(BACK, 'worker-j')?.frames[0] === 1);
}
