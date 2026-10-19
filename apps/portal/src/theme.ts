import type { MantineColorsTuple } from '@mantine/core';
import { createTheme, rem } from '@mantine/core';

// Patient portal theme: the staff palette (docs/DESIGN-SYSTEM.md) at a 16 px base with larger
// touch targets, because patients mostly use phones. Colour tuples match apps/staff/src/theme.ts.

const brand: MantineColorsTuple = ['#EDF0F9', '#D9DFF1', '#B1BEE3', '#8A9DD4', '#6880C7', '#4F69B8', '#3953A4', '#2F4588', '#25376C', '#1B2850'];
const navy: MantineColorsTuple = ['#EEF0F8', '#DCE1F0', '#B6C0DF', '#8D9CCB', '#6B7DB9', '#5568AB', '#475BA0', '#2F407D', '#1F2D5C', '#141E42'];

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 6 },
  colors: { brand, navy },
  fontFamily: "'Neue Montreal', 'Helvetica Neue', Arial, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  defaultRadius: 'md',
  radius: { xs: rem(4), sm: rem(6), md: rem(10), lg: rem(14), xl: rem(18) },
  fontSizes: { xs: rem(13), sm: rem(14), md: rem(16), lg: rem(18), xl: rem(20) },
  headings: {
    fontWeight: '650',
    sizes: {
      h1: { fontSize: rem(26), lineHeight: '1.25' },
      h2: { fontSize: rem(20), lineHeight: '1.3' },
      h3: { fontSize: rem(17), lineHeight: '1.35' },
    },
  },
  focusRing: 'auto',
  cursorType: 'pointer',
  components: {
    Button: { defaultProps: { size: 'md', radius: 'md' } },
    TextInput: { defaultProps: { size: 'md' } },
    PasswordInput: { defaultProps: { size: 'md' } },
    Select: { defaultProps: { size: 'md' } },
    Textarea: { defaultProps: { size: 'md', autosize: true, minRows: 3 } },
    Card: { defaultProps: { withBorder: true, radius: 'lg', padding: 'lg' } },
    // Sentence case: upper-case badges read as shouting to patients.
    Badge: { defaultProps: { radius: 'sm', variant: 'light', size: 'md' }, styles: { root: { textTransform: 'none', fontWeight: 600 } } },
  },
});
