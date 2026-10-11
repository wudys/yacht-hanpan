export function CapabilityFailureView({
  code,
  title,
  message,
}: Readonly<{ code: string; title: string; message: string }>) {
  return (
    <section
      className='game-status-view capability-failure-view'
      role='alert'
      data-product-view='unsupported'
      data-capability-failure={code}
    >
      <h1>{title}</h1>
      <p>{message}</p>
    </section>
  );
}
