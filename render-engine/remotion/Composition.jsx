import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate, spring, AbsoluteFill } from 'remotion';

/**
 * Komponen Remotion (Pilar 2 Peta Stack: Compositor React untuk Video)
 * Render via CLI:
 *   npx remotion render render-engine/remotion/Composition.jsx MyMotion output/remotion.mp4 --codec h264 --crf 18 --concurrency 4
 */
export const MyMotion = ({ title = 'MOTION STUDIO 2026', subtitle = 'Remotion + Playwright + FFmpeg' }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const opacity = interpolate(frame, [0, 30, durationInFrames - 20, durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const scale = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 110 },
  });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(135deg, #0a0a14 0%, #1a1040 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#ffffff',
        fontFamily: 'Inter, sans-serif',
        opacity,
      }}
    >
      <h1
        style={{
          fontSize: 120,
          fontWeight: 900,
          transform: `scale(${scale})`,
          margin: 0,
          letterSpacing: -2,
        }}
      >
        {title}
      </h1>
      <p style={{ fontSize: 38, color: '#94a3b8', marginTop: 24 }}>{subtitle}</p>
    </AbsoluteFill>
  );
};
