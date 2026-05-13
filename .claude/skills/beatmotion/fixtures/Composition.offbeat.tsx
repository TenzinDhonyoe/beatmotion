import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const LaunchVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoOpacity = interpolate(frame, [0, 22], [0, 1]);
  const heroScale = spring({ frame, fps, delayInFrames: 47, config: { damping: 12 } });
  const titleY = interpolate(frame, [55, 88], [40, 0]);

  return (
    <AbsoluteFill style={{ background: "black" }}>
      <Sequence from={5} durationInFrames={120}>
        <h1 style={{ opacity: logoOpacity }}>brand</h1>
      </Sequence>
      <Sequence from={235} durationInFrames={180}>
        <h2 style={{ transform: `translateY(${titleY}px) scale(${heroScale})` }}>
          the drop
        </h2>
      </Sequence>
    </AbsoluteFill>
  );
};
