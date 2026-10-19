import { Alert, Anchor, Stack, Text } from '@mantine/core';
import { IconLifebuoy } from '@tabler/icons-react';
import type { JSX } from 'react';

/** Shown at once when an answer suggests the patient may be in danger. Forms are not monitored live. */
export function CrisisNow(): JSX.Element {
  return (
    <Alert color="red" icon={<IconLifebuoy size={20} />} title="If you are thinking about harming yourself, please reach out now" role="alert">
      <Stack gap={4}>
        <Text size="sm"><Anchor href="tel:988" fw={700}>Call</Anchor> or <Anchor href="sms:988" fw={700}>text 988</Anchor> to talk to someone right now, any time of day.</Text>
        <Text size="sm">If you are in immediate danger, <Anchor href="tel:911" fw={700}>call 911</Anchor> or go to the nearest emergency department.</Text>
        <Text size="sm">Your care team will see your answers, but not straight away. Do not wait for us to contact you.</Text>
      </Stack>
    </Alert>
  );
}
