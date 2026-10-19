# Teleemon design system

Tokens live in `apps/staff/src/theme.ts` (Mantine theme) and `apps/staff/src/styles/global.css` (surface variables).

## Colour

| Token | Value | Use |
|---|---|---|
| `navy.8` | `#1F2D5C` | Sidebar, portal header, structure, avatar (navy in the brand's hue) |
| `brand.6` | `#3953A4` | Teleemon brand blue (from the logo): primary buttons in both modes, accents, focus ring, "next" highlight. White text on it is about 7:1 (WCAG AA). |
| Logo | `public/brand/teleemon-logo.png` / `-white.png` (marks: `teleemon-mark*.png`) | Blue artwork on light surfaces; white artwork on navy surfaces and in dark mode. The mark alone is the favicon. |
| `red` | Mantine red | Safety and blocking only: unlicensed state, expired licence, positive safety item, controlled substance |
| `orange` | Mantine orange | Needs attention soon: expiring in 31–90 days, queue item older than 24 hours |
| `green` | Mantine green | Completed, verified, enforced |
| `blue` | Mantine blue | Information, checked in |

Colour never carries meaning alone: every status has a label, and every warning has an icon.

## Type and numbers

Neue Montreal, Regular and Bold (the GG'APP brand files, self-hosted in `apps/staff/public/fonts`, no font CDN); weights 300–500 render Regular and 600–900 render Bold. Because the font has no tabular digits, `.tm-num` uses the system UI face. Base 14 px; page titles 24 px, section titles 18 px. Use the `.tm-num` class for times, counts, money and scores so digits align.

## Layout

- Page width is capped at 1320 px (`PageBody`), with an eyebrow, title and one-line summary at the top of each page (`PageHeader`).
- The desktop sidebar starts at the top alongside the header (`AppShell layout="alt"`); branding and the toolbar share a 60 px row. Upcoming sidebar destinations are grouped under Coming later.
- Registration keeps save/cancel actions in a bottom action bar below desktop width. Chart tabs expose horizontal scrolling when needed.
- Cards have a 12 px radius and a 1 px border, and no shadow until hover.
- Lists use rows, not cards: time and status sit at fixed positions so the eye can scan down a column.

## States (required on every data view)

`RowsSkeleton` while loading · `EmptyState` saying what will appear and how · `ErrorState` with **Try again**. Queues that aren't built yet say so instead of showing 0.

## Interaction

- Ctrl+K opens patient search everywhere.
- Every dashboard number opens the list it counts.
- Focus rings show for keyboard users only.
- Reduced-motion preferences are respected.
- Destructive actions use red and confirm in-app (never with a browser dialog).

## Dashboards and navigation (added with Phase 2)

- **Summary strip first.** A dashboard opens with up to four equal-width stat cards (`StatStrip`): label, one big number, one line of context, and a click that goes to the detail. Four columns on desktop, two on tablet, one on phone.
- **One card header everywhere** (`CardHeader`): title and optional count on the left, one action on the right, 32 px tall, so card bodies start on the same line across a row.
- **Lists are grids.** Header and rows share one CSS grid template, so columns align. Whole rows are clickable, with a chevron that moves on hover; status badges sit in a fixed-width column.
- **Time cues.** Schedules show a red "Now" marker; calendars show a now-line and shade closed hours.
- **Where am I.** The sidebar keeps the parent destination highlighted inside sub-pages (a chart keeps "Find patient" active). Charts carry a breadcrumb. Recently opened patients sit under Patients.
- **Keyboard.** `/` or Ctrl+K searches; Alt+T, P, C and N jump to Today, Patients, Calendar and New patient; `?` lists the shortcuts.

## Calendar

- Appointment cards use a uniform thin border, a small status dot and restrained fills. No colored left rails. The legend uses matching dots and text.
- The time grid uses 28 px per 15 minutes. Thirty-minute visits show time and patient name; 15-minute visits use one compact line; longer visits add the visit type when it fits.
- Keep 6 px side gutters and a 6 px gap between consecutive visits. Time positions, durations and overlap lanes remain proportional to the schedule.
- Week columns have a 176 px minimum width. Scroll within the calendar on narrow screens; pin weekday headings and the time gutter. Month cells also keep a minimum readable width.
- Full appointment details appear on hover or keyboard focus. Blocked time uses a neutral fill with a label, without decorative stripes.

## Patient portal (added with Phase 7)

The portal (`apps/portal`, tokens in `apps/portal/src/theme.ts`) uses the same palette, font and semantic colours as the staff app, tuned for patients on phones:

- **Base 16 px**, inputs and buttons at size `md` (at least 44 px tall). Page width capped at 760 px with 16 px side gutters.
- **Mobile navigation** is a bottom bar (Home, Visits, Messages, Summaries, Refills); on desktop the same links sit in the navy header. Limited proxies see Home and Visits only, and a blue banner says whose portal they are in and that access is limited.
- **Crisis resources on every page**: a footer with tap-to-call or text 988 and call 911. A red crisis panel (role `alert`) appears straight away when an answer or message suggests danger.
- **One task per screen**: booking and intake are steppers. Step ticks show only steps that are actually done, and every step saves to the server, so patients can stop and resume on another device.
- **Times** are shown in the time zone of the state the patient will be in, with the zone named above the time grid. Days without times stay visible but disabled ("no times").
- **Plain language**: no clinical codes, scores or internal terms. Errors say what to do next ("Call us to reschedule"), and refusals never reveal whether someone else is a patient.
- **No third parties**: self-hosted fonts and proof-of-work check, no analytics. Stripe.js loads only on the card step in Stripe mode.
