import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { Alert, Button, Field, ProgressBar, formatDuration } from '../components/ui';
import { askToNotify } from '../hooks/useJobFinished';

export function Upload({ onSubmitted, notify }) {
  const [file, setFile] = useState(null);
  const [frameStart, setFrameStart] = useState(1);
  const [frameEnd, setFrameEnd] = useState(1);
  // Asked for rather than hardcoded, so the form cannot offer an engine the
  // server would refuse or miss one it has gained.
  const [engines, setEngines] = useState([]);
  const [engine, setEngine] = useState('');
  const [formats, setFormats] = useState([]);
  const [chosen, setChosen] = useState(['PNG']);
  const [exrCodecs, setExrCodecs] = useState([]);
  const [exrDepths, setExrDepths] = useState([]);
  const [exrCodec, setExrCodec] = useState('ZIP');
  const [exrDepth, setExrDepth] = useState('16');
  const [jpegQuality, setJpegQuality] = useState(90);
  const [resolutionPercent, setResolutionPercent] = useState(100);
  // Blank means whatever the scene already specifies.
  const [samples, setSamples] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const frameCount = Math.max(0, Number(frameEnd) - Number(frameStart) + 1);

  useEffect(() => {
    let current = true;

    api.engines()
      .then(({ engines: available, formats: offered, exrCodecs: codecs, exrDepths: depths, defaults }) => {
        if (!current) return;
        setEngines(available);
        setEngine(available[0]?.id ?? '');
        setFormats(offered);
        setExrCodecs(codecs ?? []);
        setExrDepths(depths ?? []);
        setExrCodec(defaults?.exrCodec ?? 'ZIP');
        setExrDepth(defaults?.exrDepth ?? '16');
        setJpegQuality(defaults?.jpegQuality ?? 90);
      })
      .catch(err => current && setError(err.message));

    return () => { current = false; };
  }, []);

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
    if (chosen.length === 0) return setError('Choose at least one output format');

    setProgress(0);

    try {
      const result = await api.upload(
        file,
        {
          frameStart, frameEnd, renderEngine: engine, priority: urgent,
          resolutionPercent, samples, formats: chosen, exrCodec, exrDepth, jpegQuality
        },
        setProgress
      );

      notify(
        result.startsIn > 0
          ? `Job ${result.jobId} queued — starts in about ${formatDuration(result.startsIn)}`
          : `Job ${result.jobId} queued`,
        'success'
      );
      askToNotify();
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
          <select
            value={engine}
            onChange={e => setEngine(e.target.value)}
            disabled={engines.length === 0}
          >
            {engines.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="row">
        <Field
          label="Resolution %"
          type="number"
          min="1"
          max="100"
          value={resolutionPercent}
          onChange={e => setResolutionPercent(e.target.value)}
          required
        />
        <Field
          label="Samples"
          type="number"
          min="1"
          placeholder="scene default"
          value={samples}
          onChange={e => setSamples(e.target.value)}
          disabled={engine !== 'CYCLES'}
        />
      </div>

      <fieldset className="formats">
        <legend className="field-label">Output formats</legend>
        {formats.map(({ id, label }) => (
          <label key={id} className="check check-inline">
            <input
              type="checkbox"
              checked={chosen.includes(id)}
              onChange={e => setChosen(current => (
                e.target.checked ? [...current, id] : current.filter(name => name !== id)
              ))}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>

      {chosen.includes('OPEN_EXR') && (
        <div className="row">
          <label className="field">
            <span className="field-label">EXR compression</span>
            <select value={exrCodec} onChange={e => setExrCodec(e.target.value)}>
              {exrCodecs.map(({ id, label }) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">EXR colour depth</span>
            <select value={exrDepth} onChange={e => setExrDepth(e.target.value)}>
              {exrDepths.map(({ id, label }) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {chosen.includes('JPEG') && (
        <div className="row">
          <Field
            label="JPEG quality"
            type="number"
            min="1"
            max="100"
            value={jpegQuality}
            onChange={e => setJpegQuality(e.target.value)}
          />
        </div>
      )}

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
        {Number(resolutionPercent) !== 100 && ` at ${resolutionPercent}% resolution`}
        {engine === 'CYCLES' && samples && ` with ${samples} samples`}
        {chosen.includes('OPEN_EXR') && `, EXR at ${exrDepth}-bit ${exrCodec}`}
        {chosen.includes('JPEG') && `, JPEG at quality ${jpegQuality}`}
      </p>

      <Alert>{error}</Alert>

      {progress !== null && (
        <ProgressBar value={progress} label="Uploading" />
      )}

      <Button type="submit" variant="primary" busy={progress !== null}
        disabled={!file || !engine || chosen.length === 0}>
        Queue render
      </Button>
    </form>
  );
}
