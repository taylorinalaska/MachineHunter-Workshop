import { useEditor } from '../state/editor.ts';
import { Icon } from '../ui/icons.tsx';

/** Plays (or stops) the path's followers walking it in the view. */
export function WalkButton({ pathId }: { pathId: number }) {
  const walking = useEditor((s) => s.walkingPath === pathId);
  const setWalkingPath = useEditor((s) => s.setWalkingPath);
  return (
    <button className={`small ${walking ? 'primary' : ''}`} onClick={() => setWalkingPath(walking ? null : pathId)} title="Preview the walk">
      <Icon name={walking ? 'close' : 'play'} size={13} /> {walking ? 'Stop' : 'Preview'}
    </button>
  );
}
