const LOADER_DICE = [
  { face: 2, name: 'one', pips: ['tl', 'br'] },
  { face: 4, name: 'two', pips: ['tl', 'tr', 'bl', 'br'] },
  { face: 5, name: 'three', pips: ['tl', 'tr', 'cc', 'bl', 'br'] },
] as const;

type DiceLoaderVariant = 'bounce' | 'color';

function DiceLoader({ variant }: Readonly<{ variant: DiceLoaderVariant }>) {
  return (
    <div
      className={`dice-loader dice-loader--${variant}`}
      data-loader-variant={variant}
      aria-hidden='true'
    >
      <div className='dice-loader__dice'>
        {LOADER_DICE.map((die) => (
          <span
            className={`dice-loader__die dice-loader__die--${die.name}`}
            data-loader-die={die.face}
            key={die.face}
          >
            {die.pips.map((pip) => (
              <span className={`dice-loader__pip dice-loader__pip--${pip}`} key={pip} />
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}

export function BouncingDiceLoader() {
  return <DiceLoader variant='bounce' />;
}

export function ColorCycleDiceLoader() {
  return <DiceLoader variant='color' />;
}
