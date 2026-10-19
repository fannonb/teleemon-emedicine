import { Box, Group, useComputedColorScheme } from '@mantine/core';
import type { JSX } from 'react';

// Teleemon brand artwork in apps/staff/public/brand. Each file has a blue version for light
// surfaces and a '-white' version for navy surfaces.
//   tone 'white'  navy surfaces (sidebar, sign-in brand panel);
//   tone 'blue'   light surfaces;
//   tone 'auto'   blue in light mode, white in dark mode.
// The choice is made in code from the computed colour scheme, so only one image is ever rendered.

export type BrandTone = 'blue' | 'white' | 'auto';

function useTone(tone: BrandTone): 'blue' | 'white' {
  const scheme = useComputedColorScheme('light');
  if (tone === 'auto') return scheme === 'dark' ? 'white' : 'blue';
  return tone;
}

function Art({ file, tone, height, alt, align = 'center' }: { readonly file: string; readonly tone: BrandTone; readonly height: number; readonly alt: string; readonly align?: 'center' | 'flex-start' }): JSX.Element {
  const resolved = useTone(tone);
  return (
    <Box
      component="img"
      src={`/brand/${file}${resolved === 'white' ? '-white' : ''}.png`}
      alt={alt}
      style={{ height, width: 'auto', maxWidth: '100%', display: 'block', flexShrink: 0, alignSelf: align, objectFit: 'contain' }}
    />
  );
}

/** The head-and-leaves mark alone: favicon-sized uses and tight spaces. */
export function LogoMark({ size = 40, tone = 'auto' }: { readonly size?: number; readonly tone?: BrandTone }): JSX.Element {
  return <Art file="teleemon-mark" tone={tone} height={size} alt="Teleemon" />;
}

/** The "Teleemon" wordmark alone. Legible at small heights, unlike the full logo's tagline. */
export function Wordmark({ height = 24, tone = 'auto' }: { readonly height?: number; readonly tone?: BrandTone }): JSX.Element {
  return <Art file="teleemon-wordmark" tone={tone} height={height} alt="Teleemon" />;
}

/**
 * Mark and wordmark side by side: the compact lockup for headers and the sidebar. `height` is the
 * mark's height; the wordmark is sized to sit beside it.
 */
export function Logo({ inverted = true, height = 44 }: { readonly inverted?: boolean; readonly height?: number }): JSX.Element {
  const tone: BrandTone = inverted ? 'white' : 'auto';
  return (
    <Group gap={10} wrap="nowrap" align="center" aria-label="Teleemon Behavioral Health">
      <LogoMark size={height} tone={tone} />
      <Wordmark height={Math.round(height * 0.44)} tone={tone} />
    </Group>
  );
}

/** The full logo with its "Behavioral Health" tagline. Use only where it can be large (sign-in). */
export function FullLogo({ height = 150, tone = 'white' }: { readonly height?: number; readonly tone?: BrandTone }): JSX.Element {
  // In a column (sign-in brand panel) keep its natural width instead of stretching to the column.
  return <Art file="teleemon-logo" tone={tone} height={height} alt="Teleemon Behavioral Health" align="flex-start" />;
}
