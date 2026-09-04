// The job list once it stopped being the whole list: which page is polled, what
// "show older" adds, and where the counts on the tabs come from.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Jobs } from '../src/pages/Jobs';
import { api } from '../src/api/client';

function job(id, extra = {}) {
  return {
    id,
    originalFilename: `scene-${id}.blend`,
    status: 'completed',
    owner: 'painter',
    renderEngine: 'CYCLES',
    frameStart: 1,
    frameEnd: 4,
    totalFrames: 4,
    completedFrames: 4,
    failedFrames: 0,
    progress: 100,
    createdAt: new Date().toISOString(),
    frameErrors: [],
    ...extra
  };
}

function page(jobs, { counts, nextBefore = null } = {}) {
  return {
    jobs,
    counts: counts ?? { all: jobs.length, completed: jobs.length },
    nextBefore,
    usage: { bytes: 0, quota: 1000 }
  };
}

beforeEach(() => {
  // Nothing here is about download links, and each card would mint one.
  vi.spyOn(api, 'downloadToken').mockResolvedValue({ token: 'x' });
});

describe('the newest page', () => {
  it('is asked for by itself, not the whole list', async () => {
    vi.spyOn(api, 'jobs').mockResolvedValue(page([job(3), job(2), job(1)]));

    render(<Jobs notify={() => {}} />);

    await screen.findByText('scene-3.blend');

    expect(api.jobs).toHaveBeenCalledWith({ status: 'all', limit: 25 });
  });

  it('and the tabs count every job, not the ones on screen', async () => {
    vi.spyOn(api, 'jobs').mockResolvedValue(
      page([job(3)], { counts: { all: 412, completed: 400, failed: 12 } }));

    render(<Jobs notify={() => {}} />);

    await screen.findByText('scene-3.blend');

    expect(screen.getByRole('button', { name: /^all/ })).toHaveTextContent('412');
    expect(screen.getByRole('button', { name: /^failed/ })).toHaveTextContent('12');
  });

  it('offers nothing older when the server says there is none', async () => {
    vi.spyOn(api, 'jobs').mockResolvedValue(page([job(1)], { nextBefore: null }));

    render(<Jobs notify={() => {}} />);

    await screen.findByText('scene-1.blend');

    expect(screen.queryByRole('button', { name: /show older/i })).not.toBeInTheDocument();
  });
});

describe('reading further back', () => {
  it('asks for what comes before the cursor and keeps what is already shown', async () => {
    const fetcher = vi.spyOn(api, 'jobs').mockImplementation(async ({ before }) => (
      before
        ? page([job(2), job(1)], { counts: { all: 4, completed: 4 }, nextBefore: null })
        : page([job(4), job(3)], { counts: { all: 4, completed: 4 }, nextBefore: 3 })
    ));

    render(<Jobs notify={() => {}} />);
    await screen.findByText('scene-4.blend');

    await userEvent.click(screen.getByRole('button', { name: /show older/i }));

    await screen.findByText('scene-1.blend');

    expect(fetcher).toHaveBeenCalledWith({ status: 'all', before: 3, limit: 25 });
    expect(screen.getByText('scene-4.blend')).toBeInTheDocument();
    expect(screen.getByText('scene-3.blend')).toBeInTheDocument();
  });

  it('shows a job once even when it lands on both pages', async () => {
    vi.spyOn(api, 'jobs').mockImplementation(async ({ before }) => (
      before
        // The newest page already holds 3; the server hands it back again.
        ? page([job(3), job(2)], { counts: { all: 3, completed: 3 }, nextBefore: null })
        : page([job(4), job(3)], { counts: { all: 3, completed: 3 }, nextBefore: 3 })
    ));

    render(<Jobs notify={() => {}} />);
    await screen.findByText('scene-4.blend');

    await userEvent.click(screen.getByRole('button', { name: /show older/i }));
    await screen.findByText('scene-2.blend');

    expect(screen.getAllByText('scene-3.blend')).toHaveLength(1);
  });

  it('and starts again from the newest when the filter changes', async () => {
    vi.spyOn(api, 'jobs').mockImplementation(async ({ status, before }) => {
      if (status === 'failed') {
        return page([job(9, { status: 'failed' })],
          { counts: { all: 4, completed: 3, failed: 1 }, nextBefore: null });
      }

      return before
        ? page([job(1)], { counts: { all: 4, completed: 3, failed: 1 }, nextBefore: null })
        : page([job(4)], { counts: { all: 4, completed: 3, failed: 1 }, nextBefore: 4 });
    });

    render(<Jobs notify={() => {}} />);
    await screen.findByText('scene-4.blend');

    await userEvent.click(screen.getByRole('button', { name: /show older/i }));
    await screen.findByText('scene-1.blend');

    await userEvent.click(screen.getByRole('button', { name: /^failed/ }));
    await screen.findByText('scene-9.blend');

    // The older page belonged to the previous filter.
    expect(screen.queryByText('scene-1.blend')).not.toBeInTheDocument();
  });
});

describe('with nothing to show', () => {
  it('says so differently when the farm is empty than when a filter is', async () => {
    vi.spyOn(api, 'jobs').mockResolvedValue(page([], { counts: { all: 0 } }));

    const { unmount } = render(<Jobs notify={() => {}} />);
    expect(await screen.findByText(/no renders yet/i)).toBeInTheDocument();
    unmount();

    api.jobs.mockResolvedValue(page([], { counts: { all: 6, completed: 6 } }));

    render(<Jobs notify={() => {}} />);
    expect(await screen.findByText(/no all jobs/i)).toBeInTheDocument();
  });

  it('and a filter nobody is in cannot be chosen', async () => {
    vi.spyOn(api, 'jobs').mockResolvedValue(
      page([job(1)], { counts: { all: 1, completed: 1 } }));

    render(<Jobs notify={() => {}} />);
    await screen.findByText('scene-1.blend');

    expect(screen.getByRole('button', { name: /^cancelled/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^completed/ })).toBeEnabled();
  });
});

describe('when the list cannot be read', () => {
  it('says why rather than showing an empty farm', async () => {
    vi.spyOn(api, 'jobs').mockRejectedValue(
      Object.assign(new Error('The farm is not answering'), { status: 500 }));

    render(<Jobs notify={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText('The farm is not answering')).toBeInTheDocument());
  });
});
