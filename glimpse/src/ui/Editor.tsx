import { useState } from 'react';
import { useGlimpse } from '../state/store';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { Inspector } from './Inspector';

export function Editor() {
  const discardProject = useGlimpse((s) => s.discardProject);
  const project = useGlimpse((s) => s.project);
  const [selectedZoom, setSelectedZoom] = useState<string | null>(null);

  if (!project) return null;

  return (
    <div className="editor">
      <header className="topbar">
        <span className="wordmark">Glimpse</span>
        <div className="topbar-actions">
          <span className="timecode">
            {project.recording.mode === 'tab'
              ? 'Tab recording — cursor as data'
              : 'Pixel recording — cursor baked in'}
          </span>
          <button className="btn quiet" onClick={discardProject}>
            New recording
          </button>
        </div>
      </header>
      <Preview />
      <Timeline selectedZoom={selectedZoom} onSelectZoom={setSelectedZoom} />
      <Inspector selectedZoom={selectedZoom} />
    </div>
  );
}
