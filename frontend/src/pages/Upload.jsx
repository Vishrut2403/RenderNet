import { useRef, useState } from 'react';
import { api } from '../api/client';
import { Alert, Button, Field, ProgressBar } from '../components/ui';

const ENGINES = [
  ['CYCLES', 'Cycles — physically based, slower'],
  ['BLENDER_EEVEE', 'EEVEE — real-time, much faster'],
  ['BLENDER_WORKBENCH', 'Workbench — preview quality']
];

export function Upload({ onSubmitted, notify }) {
  const [file, setFile] = useState(null);
  const [frameStart, setFrameStart] = useState(1);
  const [frameEnd, setFrameEnd] = useState(1);
  const [engine, setEngine] = useState('CYCLES');
  const [urgent, setUrgent] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const frameCount = Math.max(0, Number(frameEnd) - Number(frameStart) + 1);

  function pick(selected) {
    if (!selected) return;

    if (!selected.name.toLowerCase().endsWith('.blend')) {
      setError('Only .blend files can be rendered');
      return;
    }

    setError('');
    setFile(selected);
  }

  async function submit(event) {
    event.preventDefault();
    setError('');

    if (!file) return setError('Choose a .blend file first');
    if (frameCount < 1) return setError('End frame must not precede start frame');

    setProgress(0);

    try {
      const result = await api.upload(
        file,
        { frameStart, frameEnd, renderEngine: engine, priority: urgent },
        setProgress
      );

      notify(`Job ${result.jobId} queued`, 'success');
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      onSubmitted?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setProgress(null);
    }
  }

  return (
    <form className="panel upload-panel" onSubmit={submit}>
      <div
        className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'filled' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".blend"
          hidden
          onChange={e => pick(e.target.files[0])}
        />

        {file ? (
          <>
            <strong>{file.name}</strong>
            <span>{(file.size / 1024 / 1024).toFixed(1)} MB — click to replace</span>
          </>
        ) : (
          <>
            <strong>Drop a .blend file here</strong>
            <span>or click to browse — up to 500MB</span>
          </>
        )}
      </div>

      <div className="row">
        <Field
          label="Start frame"
          type="number"
          min="0"
          value={frameStart}
          onChange={e => setFrameStart(e.target.value)}
          required
        />
        <Field
          label="End frame"
          type="number"
          min="0"
          value={frameEnd}
          onChange={e => setFrameEnd(e.target.value)}
          required
        />
        <label className="field">
          <span className="field-label">Render engine</span>
          <select value={engine} onChange={e => setEngine(e.target.value)}>
            {ENGINES.map(([value, text]) => (
              <option key={value} value={value}>{text}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="check">
        <input type="checkbox" checked={urgent} onChange={e => setUrgent(e.target.checked)} />
        <span>
          <strong>Urgent</strong>
          <span className="check-hint">
            Goes ahead of everything queued, and pauses whatever is rendering now.
            The paused job keeps its finished frames and carries on afterwards.
          </span>
        </span>
      </label>

      <p className="hint">
        {frameCount > 0
          ? `${frameCount} frame${frameCount === 1 ? '' : 's'} will be rendered`
          : 'Invalid frame range'}
      </p>

      <Alert>{error}</Alert>

      {progress !== null && (
        <ProgressBar value={progress} label="Uploading" />
      )}

      <Button type="submit" variant="primary" busy={progress !== null} disabled={!file}>
        Queue render
      </Button>
    </form>
  );
}
