import { useGlimpse } from './state/store';
import { Welcome } from './ui/Welcome';
import { RecordingBar } from './ui/RecordingBar';
import { Editor } from './ui/Editor';
import { FrameView } from './ui/FrameView';

export default function App() {
  const screen = useGlimpse((s) => s.screen);
  if (screen === 'recording') return <RecordingBar />;
  if (screen === 'editor') return <Editor />;
  if (screen === 'frame') return <FrameView />;
  return <Welcome />;
}
