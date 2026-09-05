import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { Alert, Button, Field, ProgressBar, formatDuration } from '../components/ui';
import { askToNotify } from '../hooks/useJobFinished';

export function Upload({ onSubmitted, notify }) {
  const [file, setFile] = useState(null);
  const [frameStart, setFrameStart] = useState(1);
  const [frameEnd, setFrameEnd] = useState(1);
  const [frameStep, setFrameStep] = useState(1);
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
  const [skipAssetCheck, setSkipAssetCheck] = useState(false);
  const [testFirst, setTestFirst] = useState(false);
  const [tiles, setTiles] = useState(0);
  const [progress, setProgress] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [prepared, setPrepared] = useState(null);
  const [reading, setReading] = useState(false);
  const [scene, setScene] = useState(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  // Fields the artist has set for themselves; the scene fills in the rest.
  const edited = useRef(new Set());
  // Only the file picked most recently may write to the form: an earlier one
  // whose upload is still finishing has been replaced.
  const picked = useRef(0);

  const frameCount = Number(frameEnd) < Number(frameStart)
    ? 0
    : Math.floor((Number(frameEnd) - Number(frameStart)) / Math.max(1, Number(frameStep))) + 1;
  const single = frameCount === 1;
  const busy = progress !== null || submitting;

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

  function apply(settings) {
    const fill = (name, setter, value) => {
      if (value === null || value === undefined) return;
      if (edited.current.has(name)) return;
      setter(value);
    };

    fill('frameStart', setFrameStart, settings.frameStart);
    fill('frameEnd', setFrameEnd, settings.frameEnd);
    fill('frameStep', setFrameStep, settings.frameStep);
    fill('engine', setEngine, settings.renderEngine);
    fill('resolutionPercent', setResolutionPercent, settings.resolutionPercent);
    fill('samples', setSamples, settings.samples);
    fill('formats', value => setChosen([value]), settings.format);
  }

  // Sent as soon as it is chosen rather than on submit, so it can be read while
  // the rest of the form is being filled in.
  async function prepare(selected) {
    const run = ++picked.current;

    setProgress(0);
    setScene(null);
    setReading(false);

    try {
      const uploadId = await api.prepareUpload(selected, value => {
        if (picked.current === run) setProgress(value);
      });

      if (picked.current !== run) return api.abortUpload(uploadId);

      setPrepared(uploadId);
      setProgress(null);
      setReading(true);

      const report = await api.inspectUpload(uploadId);

      if (picked.current !== run) return;

      setScene(report);
      if (report.read) apply(report.settings);
    } catch (err) {
      // The file goes up with the form instead.
      if (picked.current !== run) return;
      setProgress(null);
      setError(err.message);
    } finally {
      if (picked.current === run) setReading(false);
    }
  }

  function pick(selected) {
    if (!selected) return;

    if (!selected.name.toLowerCase().endsWith('.blend')) {
      setError('Only .blend files can be rendered');
      return;
    }

    // The same file chosen a second time is already on its way up.
    if (file && selected.name === file.name && selected.size === file.size
      && selected.lastModified === file.lastModified) return;

    setError('');
    setFile(selected);

    if (prepared) api.abortUpload(prepared);
    setPrepared(null);

    prepare(selected);
  }

  function clear() {
    picked.current++;
    setFile(null);
    setPrepared(null);
    setScene(null);
    edited.current.clear();
    if (inputRef.current) inputRef.current.value = '';
  }

  async function submit(event) {
    event.preventDefault();
    setError('');

    if (!file) return setError('Choose a .blend file first');
    if (frameCount < 1) return setError('End frame must not precede start frame');
    if (chosen.length === 0) return setError('Choose at least one output format');

    const settings = {
      frameStart, frameEnd, frameStep, renderEngine: engine, priority: urgent,
      resolutionPercent, samples, formats: chosen, exrCodec, exrDepth, jpegQuality,
      skipAssetCheck, testFrame: testFirst ? frameStart : null,
      tiles: single ? tiles : 0
    };

    setSubmitting(true);

    try {
      const result = prepared
        ? await api.queuePrepared(prepared, settings)
        : await api.upload(file, settings, setProgress);

      notify(
        result.startsIn > 0
          ? `Job ${result.jobId} queued — starts in about ${formatDuration(result.startsIn)}`
          : `Job ${result.jobId} queued`,
        'success'
      );
      askToNotify();
      clear();
      onSubmitted?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  const labelOf = (list, id) => list.find(item => item.id === id)?.label ?? id;

  function facts({ active, settings }) {
    const parts = [active, `frames ${settings.frameStart}–${settings.frameEnd}`
      + (settings.frameStep > 1 ? ` by ${settings.frameStep}` : '')];

    if (settings.renderEngine) parts.push(labelOf(engines, settings.renderEngine));
    if (settings.resolutionPercent) parts.push(`${settings.resolutionPercent}%`);
    if (settings.samples) parts.push(`${settings.samples} samples`);
    if (settings.format) parts.push(labelOf(formats, settings.format));

    return parts.join(' · ');
  }

  return (
    <form className="panel upload-panel" onSubmit={submit}>
      <div
        className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'filled' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={file ? `${file.name} chosen — choose a different .blend file` : 'Choose a .blend file'}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          inputRef.current?.click();
        }}
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
            <span>or click to browse</span>
          </>
        )}
      </div>

      {(reading || scene) && (
        <div className="scene-read">
          <span className="scene-facts">
            {reading && 'Reading the scene…'}
            {!reading && scene?.read && facts(scene)}
            {!reading && scene && !scene.read && 'The scene could not be read'}
          </span>
          {!reading && scene?.warnings?.map(note => (
            <span key={note} className="scene-note">{note}</span>
          ))}
        </div>
      )}

      <div className="upload-what" onChangeCapture={e => edited.current.add(e.target.name)}>
        <div className="row">
          <Field
            label="Start frame"
            name="frameStart"
            type="number"
            min="0"
            value={frameStart}
            onChange={e => setFrameStart(e.target.value)}
            required
          />
          <Field
            label="End frame"
            name="frameEnd"
            type="number"
            min="0"
            value={frameEnd}
            onChange={e => setFrameEnd(e.target.value)}
            required
          />
          <Field
            label="Step"
            name="frameStep"
            type="number"
            min="1"
            value={frameStep}
            onChange={e => setFrameStep(e.target.value)}
            required
          />
          <label className="field">
            <span className="field-label">Render engine</span>
            <select
              name="engine"
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
            name="resolutionPercent"
            type="number"
            min="1"
            max="100"
            value={resolutionPercent}
            onChange={e => setResolutionPercent(e.target.value)}
            required
          />
          <Field
            label="Samples"
            name="samples"
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
                name="formats"
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
      </div>

      <div className="upload-how">
        <label className="check">
          <input type="checkbox" checked={urgent} onChange={e => setUrgent(e.target.checked)} />
          <span>Urgent</span>
        </label>

        {single && (
          <label className="field">
            <span className="field-label">Split this frame across machines</span>
            <select value={tiles} onChange={e => setTiles(Number(e.target.value))}>
              <option value={0}>No</option>
              {[2, 4, 6, 9, 12, 16].map(count => (
                <option key={count} value={count}>{count} tiles</option>
              ))}
            </select>
          </label>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={testFirst}
            disabled={frameCount < 2}
            onChange={e => setTestFirst(e.target.checked)}
          />
          <span>Render frame {frameStart} first and wait</span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={skipAssetCheck}
            onChange={e => setSkipAssetCheck(e.target.checked)}
          />
          <span>Render even if files are missing</span>
        </label>
      </div>

      <div className="upload-go">
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

        <Button type="submit" variant="primary" busy={busy}
          disabled={!file || !engine || chosen.length === 0 || busy}>
          Queue render
        </Button>
      </div>
    </form>
  );
}
