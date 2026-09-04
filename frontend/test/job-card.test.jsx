// What a job card offers depends entirely on the state the job is in, and
// offering the wrong thing is how somebody deletes a render that is still going.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobCard } from '../src/components/JobCard';
import { api } from '../src/api/client';

function job(extra = {}) {
  return {
    id: 12,
    originalFilename: 'shot.blend',
    status: 'completed',
    owner: 'painter',
    renderEngine: 'CYCLES',
    frameStart: 1,
    frameEnd: 8,
    totalFrames: 8,
    completedFrames: 8,
    failedFrames: 0,
    progress: 100,
    createdAt: new Date().toISOString(),
    frameErrors: [],
    ...extra
  };
}

function show(overrides = {}, handlers = {}) {
  return render(
    <JobCard job={job(overrides)} onChanged={handlers.onChanged ?? (() => {})}
      onError={handlers.onError ?? (() => {})} />
  );
}

const button = name => screen.queryByRole('button', { name });

beforeEach(() => {
  vi.spyOn(api, 'downloadToken').mockResolvedValue({ token: 'scoped-token' });
});

describe('a job still going', () => {
  it('can be hurried or stopped, but not deleted', async () => {
    show({ status: 'rendering', completedFrames: 3, progress: 37 });

    expect(button(/mark urgent/i)).toBeInTheDocument();
    expect(button(/^cancel$/i)).toBeInTheDocument();
    expect(button(/delete/i)).not.toBeInTheDocument();
    expect(button(/rerun/i)).not.toBeInTheDocument();
  });

  it('and says which frame it is on', () => {
    show({ status: 'rendering', completedFrames: 3, currentFrame: 3, progress: 37 });

    expect(screen.getByText(/rendering frame 4 of 8/i)).toBeInTheDocument();
  });
});

describe('a job waiting to be approved', () => {
  it('offers to render the rest instead of the usual queue controls', () => {
    show({ status: 'pending', approval: 'waiting', testFrame: 1, completedFrames: 1,
      totalFrames: 48, frameEnd: 48 });

    expect(button(/render the rest/i)).toBeInTheDocument();
    expect(button(/^cancel$/i)).toBeInTheDocument();
    // Hurrying a job that is waiting on a person would do nothing.
    expect(button(/mark urgent/i)).not.toBeInTheDocument();
  });

  it('says how many frames are being held back', () => {
    show({ status: 'pending', approval: 'waiting', testFrame: 1, completedFrames: 1,
      totalFrames: 48, frameEnd: 48 });

    expect(screen.getByText(/render the other 47 frames/i)).toBeInTheDocument();
  });

  it('and approving it tells the farm and then the page', async () => {
    const approve = vi.spyOn(api, 'approveJob').mockResolvedValue({ success: true });
    const onChanged = vi.fn();

    show({ status: 'pending', approval: 'waiting', testFrame: 1, completedFrames: 1,
      totalFrames: 48, frameEnd: 48 }, { onChanged });

    await userEvent.click(button(/render the rest/i));

    expect(approve).toHaveBeenCalledWith(12);
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('a job that has stopped', () => {
  it('can be downloaded and deleted, but not cancelled', async () => {
    show({ status: 'completed' });

    expect(await screen.findByRole('link', { name: /download zip/i })).toBeInTheDocument();
    expect(button(/delete/i)).toBeInTheDocument();
    expect(button(/^cancel$/i)).not.toBeInTheDocument();
  });

  it('offers a rerun only when there are failed frames to retry', () => {
    const { unmount } = show({ status: 'failed', completedFrames: 6, failedFrames: 2,
      frameErrors: [{ frame: 7, error: 'out of memory' }, { frame: 8, error: 'out of memory' }] });

    expect(button(/rerun 2 failed frames/i)).toBeInTheDocument();
    unmount();

    show({ status: 'completed', frameErrors: [] });
    expect(button(/rerun/i)).not.toBeInTheDocument();
  });
});

describe('a still rendered in tiles', () => {
  it('is described by its regions rather than a frame range', () => {
    show({ tiles: 4, frameStart: 12, frameEnd: 12, totalFrames: 4, completedFrames: 4 });

    expect(screen.getByText(/frame 12 in 4 tiles/i)).toBeInTheDocument();
    expect(screen.queryByText(/frames 12–12/)).not.toBeInTheDocument();
  });

  it('and counts tiles while they arrive', () => {
    show({ tiles: 4, frameStart: 12, frameEnd: 12, totalFrames: 4, completedFrames: 2,
      status: 'rendering', progress: 50 });

    expect(screen.getByText(/2 of 4 tiles/i)).toBeInTheDocument();
  });

  it('and says when the pieces are being put together', () => {
    show({ tiles: 4, frameStart: 12, frameEnd: 12, totalFrames: 4, completedFrames: 4,
      status: 'rendering', composite: 'running', progress: 100 });

    expect(screen.getByText(/putting the tiles together/i)).toBeInTheDocument();
  });
});

describe('cancelling', () => {
  it('asks first, because it deletes the frames already rendered', async () => {
    const cancel = vi.spyOn(api, 'cancelJob').mockResolvedValue({ success: true });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    show({ status: 'rendering', completedFrames: 3 });

    await userEvent.click(button(/^cancel$/i));

    expect(window.confirm).toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('and goes ahead once it has been agreed to', async () => {
    const cancel = vi.spyOn(api, 'cancelJob').mockResolvedValue({ success: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onChanged = vi.fn();

    show({ status: 'rendering', completedFrames: 3 }, { onChanged });

    await userEvent.click(button(/^cancel$/i));

    expect(cancel).toHaveBeenCalledWith(12);
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('an admin looking at somebody else\'s job', () => {
  function asAdmin() {
    localStorage.setItem('rendernet.user',
      JSON.stringify({ username: 'admin', role: 'admin' }));
  }

  afterEach(() => localStorage.clear());

  it('is offered the two overrides an owner does not get', () => {
    const { unmount } = show({ status: 'rendering' });

    expect(button(/render next/i)).not.toBeInTheDocument();
    expect(button(/^hold$/i)).not.toBeInTheDocument();
    unmount();

    asAdmin();
    show({ status: 'rendering' });

    expect(button(/render next/i)).toBeInTheDocument();
    expect(button(/^hold$/i)).toBeInTheDocument();
  });

  it('but not on a job that has already stopped', () => {
    asAdmin();
    show({ status: 'completed' });

    expect(button(/render next/i)).not.toBeInTheDocument();
    expect(button(/^hold$/i)).not.toBeInTheDocument();
  });

  it('nor on one waiting for its owner to approve a frame', () => {
    asAdmin();
    show({ status: 'pending', approval: 'waiting', testFrame: 1, completedFrames: 1,
      totalFrames: 48, frameEnd: 48 });

    expect(button(/render next/i)).not.toBeInTheDocument();
    expect(button(/^hold$/i)).not.toBeInTheDocument();
  });

  it('and holding one asks the farm and then the page', async () => {
    const hold = vi.spyOn(api, 'holdJob').mockResolvedValue({ success: true });
    const onChanged = vi.fn();

    asAdmin();
    show({ status: 'rendering' }, { onChanged });

    await userEvent.click(button(/^hold$/i));

    expect(hold).toHaveBeenCalledWith(12);
    expect(onChanged).toHaveBeenCalled();
  });

  it('a held job offers to be let go instead, and says who holds it', async () => {
    const release = vi.spyOn(api, 'releaseJob').mockResolvedValue({ success: true });

    asAdmin();
    show({ status: 'pending', heldBy: 'admin' });

    expect(screen.getByText(/held by admin/i)).toBeInTheDocument();
    expect(button(/^hold$/i)).not.toBeInTheDocument();

    await userEvent.click(button(/release/i));

    expect(release).toHaveBeenCalledWith(12);
  });

  it('and pinning one warns that it stops what is rendering', async () => {
    const pin = vi.spyOn(api, 'pinJob').mockResolvedValue({ success: true });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    asAdmin();
    show({ status: 'pending' });

    await userEvent.click(button(/render next/i));

    expect(window.confirm).toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
  });

  it('a pinned job says so and offers to be unpinned, without asking again', async () => {
    const pin = vi.spyOn(api, 'pinJob').mockResolvedValue({ success: true });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    asAdmin();
    show({ status: 'pending', pinnedAt: new Date().toISOString() });

    expect(screen.getByText(/^next$/i)).toBeInTheDocument();

    await userEvent.click(button(/unpin/i));

    expect(window.confirm).not.toHaveBeenCalled();
    expect(pin).toHaveBeenCalledWith(12, false);
  });
});

describe('when an action is refused', () => {
  it('the reason reaches the page rather than being swallowed', async () => {
    vi.spyOn(api, 'approveJob').mockRejectedValue(new Error('Job 12 is not waiting'));
    const onError = vi.fn();

    show({ status: 'pending', approval: 'waiting', testFrame: 1, completedFrames: 1,
      totalFrames: 48, frameEnd: 48 }, { onError });

    await userEvent.click(button(/render the rest/i));

    expect(onError).toHaveBeenCalledWith('Job 12 is not waiting');
  });
});
