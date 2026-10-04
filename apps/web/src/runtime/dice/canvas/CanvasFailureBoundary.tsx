import { Component, type ReactNode } from 'react';

import type { RendererReadiness } from '@/runtime/dice/canvas/renderer-readiness';

type BoundaryProps = Readonly<{
  renderer: RendererReadiness;
  attempt: number;
  children: ReactNode;
}>;

export class CanvasFailureBoundary extends Component<
  BoundaryProps,
  { failed: boolean; attempt: number }
> {
  public state: { failed: boolean; attempt: number } = {
    failed: false,
    attempt: this.props.attempt,
  };

  public static getDerivedStateFromError() {
    return { failed: true };
  }

  public static getDerivedStateFromProps(
    props: BoundaryProps,
    state: { failed: boolean; attempt: number },
  ) {
    return props.attempt !== state.attempt ? { failed: false, attempt: props.attempt } : null;
  }

  public componentDidCatch(error: Error) {
    this.props.renderer.fail(this.props.attempt, error);
  }

  public render() {
    return this.state.failed ? null : this.props.children;
  }
}
