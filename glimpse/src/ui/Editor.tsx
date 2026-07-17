import { useEffect, useState } from 'react';
import { useGlimpse } from '../state/store';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { Inspector } from './Inspector';
import { ThemeToggle } from './ThemeToggle';

export function Editor() {
  const discardProject = useGlimpse((s) => s.discardProject);
  const saveProject = useGlimpse((s) => s.saveProject);
  const openProject = useGlimpse((s) => s.openProject);
  const setProjectName = useGlimpse((s) => s.setProjectName);
  const project = useGlimpse((s) => s.project);
  const [selectedZoom, setSelectedZoom] = useState<string | null>(null);

  // Space = play/pause (trim-aware), ←/→ = frame step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        t.tagName === 'INPUT' ||
        t.tagName === 'SELECT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable
      ) {
        return;
      }
      const st = useGlimpse.getState();
      if (!st.project) return;
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
          <span className="wordmark">Glimpse</span>
          <input
            className="project-name"
            value={project.name}
            onChange={(e) => setProjectName(e.target.value)}
            aria-label="Project name"
            spellCheck={false}
          />
        </div>
        <div className="topbar-actions">
          <span className="timecode">
            {project.recording.cursor.length > 0
              ? 'Cursor as data'
              : 'Cursor baked in'}
          </span>
          <button className="btn quiet" onClick={confirmNew}>
            New
          </button>
          <button className="btn quiet" onClick={() => void openProject()}>
            Open
          </button>
          <button className="btn" onClick={() => void saveProject(false)}>
            Save
          </button>
          <button className="btn quiet" onClick={() => void saveProject(true)}>
            Save as…
          </button>
          <ThemeToggle />
        </div>
      </header>
      <Preview selectedZoom={selectedZoom} />
      <Timeline selectedZoom={selectedZoom} onSelectZoom={setSelectedZoom} />
      <Inspector selectedZoom={selectedZoom} />
    </div>
  );
}
