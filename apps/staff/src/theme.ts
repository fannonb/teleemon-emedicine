import type { MantineColorsTuple } from '@mantine/core';
import { createTheme, rem } from '@mantine/core';

// Teleemon design tokens. See docs/DESIGN-SYSTEM.md for usage rules.

/** Primary action colour. Shade 6 (#3953A4) is the Teleemon brand blue from the logo. */
const brand: MantineColorsTuple = ['#EDF0F9', '#D9DFF1', '#B1BEE3', '#8A9DD4', '#6880C7', '#4F69B8', '#3953A4', '#2F4588', '#25376C', '#1B2850'];

/** Structural colour: sidebar, headings, patient header. Shade 8 (#1F2D5C) is a deep navy in the brand's hue. */
const navy: MantineColorsTuple = ['#EEF0F8', '#DCE1F0', '#B6C0DF', '#8D9CCB', '#6B7DB9', '#5568AB', '#475BA0', '#2F407D', '#1F2D5C', '#141E42'];

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 6 },
  colors: { brand, navy },
  fontFamily: "'Neue Montreal', 'Helvetica Neue', Arial, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontFamilyMonospace: "ui-monospace, 'Cascadia Code', 'Segoe UI Mono', Menlo, monospace",
  defaultRadius: 'md',
  radius: { xs: rem(4), sm: rem(6), md: rem(8), lg: rem(12), xl: rem(16) },
  fontSizes: {
    xs: rem(12),
    sm: rem(13),
    md: rem(14),
    lg: rem(16),
    xl: rem(18),
  },
  headings: {
    fontWeight: '650',
    sizes: {
      h1: { fontSize: rem(24), lineHeight: '1.25' },
      h2: { fontSize: rem(18), lineHeight: '1.3' },
      h3: { fontSize: rem(15), lineHeight: '1.35' },
      h4: { fontSize: rem(14), lineHeight: '1.4' },
    },
  },
  focusRing: 'auto',
  cursorType: 'pointer',
  components: {
    Card: { defaultProps: { withBorder: true, radius: 'lg', padding: 'lg' } },
    Paper: { defaultProps: { radius: 'lg' } },
    Badge: { defaultProps: { radius: 'sm', variant: 'light' } },
    Button: { defaultProps: { radius: 'md' } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 300 } },
  },
  other: {
    sidebarWidth: 248,
  },
});
