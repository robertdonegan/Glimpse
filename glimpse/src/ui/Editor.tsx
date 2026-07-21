import { useEffect, useState } from 'react';
import { useGlimpse } from '../state/store';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { Inspector } from './Inspector';
import { Icon, LogoMark } from './Icon';
import { toggleTheme } from './ThemeToggle';

export function Editor() {
  const discardProject = useGlimpse((s) => s.discardProject);
  const saveProject = useGlimpse((s) => s.saveProject);
  const openProject = useGlimpse((s) => s.openProject);
  const setProjectName = useGlimpse((s) => s.setProjectName);
  const project = useGlimpse((s) => s.project);
  const dirty = useGlimpse((s) => s.dirty);
  const undo = useGlimpse((s) => s.undo);
  const redo = useGlimpse((s) => s.redo);
  const canUndo = useGlimpse((s) => s.past.length > 0);
  const canRedo = useGlimpse((s) => s.future.length > 0);
  const [selectedZoom, setSelectedZoom] = useState<string | null>(null);
  const [gizmo, setGizmo] = useState(false);

  // Space = play/pause (trim-aware), ←/→ = frame step, Cmd/Ctrl+Z undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useGlimpse.getState();
      if (!st.project) return;
      // Undo/redo work even from inputs — they're global editor actions.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        st.redo();
        return;
      }
      const t = e.target as HTMLElement;
      if (
        t.tagName === 'INPUT' ||
        t.tagName === 'SELECT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        st.togglePlay();
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        const frame = 1000 / st.project.output.fps;
        st.setPlaying(false);
        st.setPlayhead(st.playhead + (e.code === 'ArrowLeft' ? -frame : frame));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Backspace / Delete removes the selected zoom (with a confirm). Separate
  // effect so it always sees the current selection.
  useEffect(() => {
    if (!selectedZoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Backspace' && e.code !== 'Delete') return;
      const t = e.target as HTMLElement;
      if (
        t.tagName === 'INPUT' ||
        t.tagName === 'SELECT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      const st = useGlimpse.getState();
      const z = st.project?.zooms.find((zz) => zz.id === selectedZoom);
      const label = z ? `${z.scale.toFixed(1)}× zoom` : 'zoom';
      if (window.confirm(`Delete this ${label}?`)) {
        st.removeZoom(selectedZoom);
        setSelectedZoom(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedZoom]);

  if (!project) return null;

  const confirmNew = () => {
    if (window.confirm('Start a new recording? Unsaved changes will be lost.')) {
      discardProject();
    }
  };

  return (
    <div className="editor">
      <header className="topbar">
        <div className="topbar-left">
          {/* Placeholder logo — clicking it swaps light/dark mode. */}
          <button
            className="logo-btn"
            onClick={toggleTheme}
            title="Toggle light / dark mode"
            aria-label="Toggle colour theme"
          >
            <LogoMark size={32} />
          </button>
          <input
            className="project-name"
            value={project.name}
            onChange={(e) => setProjectName(e.target.value)}
            aria-label="Project name"
            spellCheck={false}
            style={{ width: `${Math.max(8, project.name.length + 1)}ch` }}
          />
          {dirty && (
            <span className="dirty-star" title="Unsaved changes">
              *
            </span>
          )}
        </div>
        <div className="topbar-actions">
          <div className="undo-redo">
            <button
              className="btn quiet icon-btn"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (⌘Z)"
              aria-label="Undo"
            >
              <Icon name="undo" />
            </button>
            <button
              className="btn quiet icon-btn"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (⇧⌘Z)"
              aria-label="Redo"
            >
              <Icon name="redo" />
            </button>
          </div>
          <button className="btn quiet" onClick={confirmNew}>
            <Icon name="plus" />
            New recording
          </button>
          <button className="btn quiet" onClick={() => void openProject()}>
            <Icon name="open" />
            Open
          </button>
          <button className="btn primary" onClick={() => void saveProject(false)}>
            <Icon name="save" />
            Save
          </button>
          <button className="btn quiet" onClick={() => void saveProject(true)}>
            <Icon name="save-as" />
            Save as…
          </button>
        </div>
      </header>
      <Preview selectedZoom={selectedZoom} gizmo={gizmo} />
      <Timeline selectedZoom={selectedZoom} onSelectZoom={setSelectedZoom} />
      <Inspector selectedZoom={selectedZoom} gizmo={gizmo} onToggleGizmo={() => setGizmo((g) => !g)} />
    </div>
  );
}
