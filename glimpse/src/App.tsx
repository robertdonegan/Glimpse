import { useGlimpse } from './state/store';
import { Welcome } from './ui/Welcome';
import { RecordingBar } from './ui/RecordingBar';
import { Editor } from './ui/Editor';

export default function App() {
  const screen = useGlimpse((s) => s.screen);
  if (screen === 'recording') return <RecordingBar />;
  if (screen === 'editor') return <Editor />;
  return <Welcome />;
}
