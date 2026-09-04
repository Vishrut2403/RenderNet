// The form fills itself in from the scene the artist just chose. What matters
// is that it never overwrites a decision they have already made, and that the
// file goes up once rather than twice.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Upload } from '../src/pages/Upload';
import { api } from '../src/api/client';

const SETTINGS = {
  frameStart: 7,
  frameEnd: 250,
  frameStep: 1,
  renderEngine: 'CYCLES',
  resolutionPercent: 50,
  samples: 128,
  format: 'OPEN_EXR',
  width: 1920,
  height: 1080,
  camera: 'Camera'
};

function reading(extra = {}) {
  return {
    read: true, active: 'Scene', scenes: ['Scene'], settings: SETTINGS, warnings: [], ...extra
  };
}

function show(notify = () => {}) {
  return render(<Upload onSubmitted={() => {}} notify={notify} />);
}

function choose(container, name = 'shot.blend') {
  const input = container.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [new File(['x'], name)] } });
}

function chooseSame(container, file) {
  const input = container.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [file] } });
}

const field = label => screen.getByLabelText(label);

beforeEach(() => {
  vi.spyOn(api, 'engines').mockResolvedValue({
    engines: [{ id: 'CYCLES', label: 'Cycles' }, { id: 'BLENDER_EEVEE', label: 'EEVEE' }],
    formats: [{ id: 'PNG', label: 'PNG' }, { id: 'OPEN_EXR', label: 'OpenEXR' }],
    exrCodecs: [{ id: 'ZIP', label: 'ZIP' }],
    exrDepths: [{ id: '16', label: '16-bit half' }],
    defaults: { exrCodec: 'ZIP', exrDepth: '16', jpegQuality: 90 }
  });

  vi.spyOn(api, 'prepareUpload').mockResolvedValue('upload-1');
  vi.spyOn(api, 'abortUpload').mockResolvedValue(undefined);
  vi.spyOn(api, 'queuePrepared').mockResolvedValue({ jobId: 5 });
  vi.spyOn(api, 'upload').mockResolvedValue({ jobId: 6 });
});

describe('choosing a scene', () => {
  it('sends it straight away rather than waiting for the form', async () => {
    vi.spyOn(api, 'inspectUpload').mockResolvedValue(reading());

    const { container } = show();
    choose(container);

    await waitFor(() => expect(api.prepareUpload).toHaveBeenCalled());
    expect(api.prepareUpload.mock.calls[0][0].name).toBe('shot.blend');
  });

  it('and fills the form in with what the scene was saved with', async () => {
    vi.spyOn(api, 'inspectUpload').mockResolvedValue(reading());

    const { container } = show();
    choose(container);

    await waitFor(() => expect(field('End frame')).toHaveValue(250));
    expect(field('Start frame')).toHaveValue(7);
    expect(field('Render engine')).toHaveValue('CYCLES');
    expect(field('Resolution %')).toHaveValue(50);
    expect(field('Samples')).toHaveValue(128);
    expect(screen.getByRole('checkbox', { name: 'OpenEXR' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'PNG' })).not.toBeChecked();
  });

  it('says what it found', async () => {
    vi.spyOn(api, 'inspectUpload').mockResolvedValue(reading());

    const { container } = show();
    choose(container);

    await waitFor(() =>
      expect(screen.getByText(/Scene · frames 7–250 · Cycles · 50% · 128 samples/)).toBeInTheDocument());
  });

  it('and what it cannot carry across', async () => {
    vi.spyOn(api, 'inspectUpload').mockResolvedValue(reading({
      warnings: ['Scene has no camera', 'Frame step 3 is not applied']
    }));

    const { container } = show();
    choose(container);

    expect(await screen.findByText('Scene has no camera')).toBeInTheDocument();
    expect(screen.getByText('Frame step 3 is not applied')).toBeInTheDocument();
  });
});

describe('a decision the artist has already made', () => {
  it('is not overwritten when the scene comes back', async () => {
    let answer;
    vi.spyOn(api, 'inspectUpload').mockReturnValue(new Promise(resolve => { answer = resolve; }));

    const user = userEvent.setup();
    const { container } = show();
    choose(container);

    await waitFor(() => expect(api.inspectUpload).toHaveBeenCalled());

    await user.clear(field('End frame'));
    await user.type(field('End frame'), '12');

    answer(reading());

    // The fields it did not touch still fill in.
    await waitFor(() => expect(field('Start frame')).toHaveValue(7));
    expect(field('End frame')).toHaveValue(12);
  });
});

describe('submitting', () => {
  it('queues from the file already sent rather than sending it again', async () => {
    vi.spyOn(api, 'inspectUpload').mockResolvedValue(reading());

    const user = userEvent.setup();
    const { container } = show();
    choose(container);

    await waitFor(() => expect(field('End frame')).toHaveValue(250));
    await user.click(screen.getByRole('button', { name: /queue render/i }));

    await waitFor(() => expect(api.queuePrepared).toHaveBeenCalled());
    expect(api.queuePrepared.mock.calls[0][0]).toBe('upload-1');
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('and sends it with the form when it could not go early', async () => {
    api.prepareUpload.mockRejectedValue(new Error('Not enough disk left'));
    vi.spyOn(api, 'inspectUpload').mockResolvedValue(reading());

    const user = userEvent.setup();
    const { container } = show();
    choose(container);

    expect(await screen.findByText('Not enough disk left')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /queue render/i }));

    await waitFor(() => expect(api.upload).toHaveBeenCalled());
    expect(api.queuePrepared).not.toHaveBeenCalled();
  });
});

describe('a scene that cannot be read', () => {
  it('leaves the form alone and still queues what was sent', async () => {
    vi.spyOn(api, 'inspectUpload').mockResolvedValue({
      read: false, active: null, scenes: [], settings: null, warnings: []
    });

    const user = userEvent.setup();
    const { container } = show();
    choose(container);

    expect(await screen.findByText('The scene could not be read')).toBeInTheDocument();
    expect(field('End frame')).toHaveValue(1);

    await user.click(screen.getByRole('button', { name: /queue render/i }));

    await waitFor(() => expect(api.queuePrepared).toHaveBeenCalled());
  });
});

describe('picking a different file', () => {
  it('lets go of the one already sent', async () => {
    vi.spyOn(api, 'inspectUpload').mockResolvedValue(reading());

    const { container } = show();
    choose(container, 'first.blend');

    await waitFor(() => expect(field('End frame')).toHaveValue(250));

    api.prepareUpload.mockResolvedValue('upload-2');
    choose(container, 'second.blend');

    await waitFor(() => expect(api.abortUpload).toHaveBeenCalledWith('upload-1'));
    expect(api.prepareUpload).toHaveBeenCalledTimes(2);
  });

  it('but the same file again is left where it is', async () => {
    vi.spyOn(api, 'inspectUpload').mockResolvedValue(reading());

    const { container } = show();
    const same = new File(['x'], 'shot.blend');

    chooseSame(container, same);
    await waitFor(() => expect(field('End frame')).toHaveValue(250));

    chooseSame(container, same);

    expect(api.prepareUpload).toHaveBeenCalledTimes(1);
    expect(api.abortUpload).not.toHaveBeenCalled();
  });
});
