import '@/document.css';
import '@/ui/theme/tokens.css';
import '@/ui/layout/frame.css';
import '@/runtime/dice/canvas.css';
import '@/dev/physics-diagnostic.css';

import { createRoot } from 'react-dom/client';

import { PhysicsDiagnostic } from '@/dev/PhysicsDiagnostic';

const element = document.getElementById('root');
if (!element) throw new Error('Missing physics diagnostic root');
createRoot(element).render(<PhysicsDiagnostic />);
