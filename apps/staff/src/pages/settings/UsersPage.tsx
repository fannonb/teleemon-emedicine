import { Alert, Badge, Button, Card, Group, Menu, Modal, PasswordInput, Select, SimpleGrid, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { getReferenceString, normalizeErrorString } from '@medplum/core';
import type { AccessPolicy, ProjectMembership, Resource, User } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconDots, IconShieldCheck, IconShieldOff, IconUserPlus, IconUsersGroup } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';

const ROLE_POLICY_PREFIX = 'Teleemon ';
const ADMIN = '__admin__';

interface Member {
  readonly membership: ProjectMembership;
  readonly user?: User;
}

function roleLabel(m: ProjectMembership): string {
  if (m.admin) return 'Administrator';
  return m.accessPolicy?.display?.replace(ROLE_POLICY_PREFIX, '') ?? 'No role';
}

// P43 Users, roles and security.
export function UsersPage(): JSX.Element {
  const medplum = useMedplum();
  const projectId = medplum.getProject()?.id as string;
  const [inviting, setInviting] = useState(false);

  const data = useLoader(async () => {
    const [bundle, policies] = await Promise.all([
      medplum.search('ProjectMembership', { _count: '200', _include: 'ProjectMembership:user' }, { cache: 'no-cache' }),
      medplum.searchResources('AccessPolicy', { _count: '50' }, { cache: 'no-cache' }),
    ]);
    const users = new Map<string, User>();
    const memberships: ProjectMembership[] = [];
    for (const e of bundle.entry ?? []) {
      const r = e.resource as Resource | undefined;
      if (r?.resourceType === 'User') users.set(`User/${r.id}`, r);
      if (r?.resourceType === 'ProjectMembership') memberships.push(r);
    }
    // People only: hide Bots and service clients.
    const members: Member[] = memberships
      .filter((m) => m.profile?.reference?.startsWith('Practitioner/'))
      .map((m) => ({ membership: m, user: users.get(m.user?.reference ?? '') }))
      .sort((a, b) => (a.membership.profile?.display ?? '').localeCompare(b.membership.profile?.display ?? ''));
    const roles = policies.filter((p) => p.name?.startsWith(ROLE_POLICY_PREFIX) && !p.name.includes('Bot'));
    return { members, roles };
  }, [medplum]);

  const mfaRequired = medplum.getProject()?.setting?.find((s) => s.name === 'mfaRequired')?.valueBoolean === true;

  const update = async (m: ProjectMembership, changes: Partial<ProjectMembership>, message: string): Promise<void> => {
    try {
      await medplum.post(`admin/projects/${projectId}/members/${m.id}`, { ...m, ...changes });
      notifications.show({ color: 'brand', message });
      data.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not changed', message: normalizeErrorString(err) });
    }
  };

  const setRole = (m: ProjectMembership, value: string, roles: AccessPolicy[]): Promise<void> => {
    if (value === ADMIN) return update(m, { admin: true, accessPolicy: undefined }, 'Role changed to Administrator.');
    const p = roles.find((r) => r.id === value);
    return update(m, { admin: false, accessPolicy: p ? { reference: getReferenceString(p), display: p.name } : undefined }, `Role changed to ${p?.name?.replace(ROLE_POLICY_PREFIX, '')}.`);
  };

  const resetMfa = async (m: ProjectMembership): Promise<void> => {
    try {
      await medplum.post(`admin/projects/${projectId}/members/${m.id}/mfa/reset`, {});
      notifications.show({ color: 'orange', message: 'MFA reset. The user must enrol a new authenticator at next sign-in.' });
      data.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not reset', message: normalizeErrorString(err) });
    }
  };

  return (
    <PageBody>
      <PageHeader
        eyebrow="P43 · Settings"
        title="Users, roles and security"
        subtitle="Roles are enforced by the server on every request. Every change here is recorded."
        actions={
          <Button leftSection={<IconUserPlus size={16} />} onClick={() => setInviting(true)}>
            Invite user
          </Button>
        }
      />
      <Card padding="md" mb="lg">
        <Group gap="sm">
          {mfaRequired ? <IconShieldCheck color="var(--mantine-color-green-6)" /> : <IconShieldOff color="var(--mantine-color-orange-6)" />}
          <Text size="sm">
            {mfaRequired ? 'Two-factor sign-in is required for everyone in this project.' : 'Two-factor sign-in is not enforced yet. Run `npm run setup -- --mfa`.'}
          </Text>
        </Group>
      </Card>
      <Section loaded={data} isEmpty={(d) => d.members.length === 0} empty={{ icon: <IconUsersGroup size={22} />, title: 'No users yet' }}>
        {({ members, roles }) => (
          <Table.ScrollContainer minWidth={760}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>User</Table.Th>
                  <Table.Th>Role</Table.Th>
                  <Table.Th>Two-factor</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Since</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {members.map(({ membership: m, user }) => (
                  <Table.Tr key={m.id} style={{ opacity: m.active === false ? 0.55 : 1 }}>
                    <Table.Td>
                      <Text size="sm" fw={600}>
                        {m.profile?.display ?? m.profile?.reference}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {user?.email ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        w={170}
                        value={m.admin ? ADMIN : (roles.find((r) => getReferenceString(r) === m.accessPolicy?.reference)?.id ?? null)}
                        placeholder={roleLabel(m)}
                        data={[{ value: ADMIN, label: 'Administrator' }, ...roles.map((r) => ({ value: r.id as string, label: r.name?.replace(ROLE_POLICY_PREFIX, '') as string }))]}
                        onChange={(v) => v && setRole(m, v, roles)}
                        aria-label="Role"
                      />
                    </Table.Td>
                    <Table.Td>
                      {user?.mfaEnrolled ? (
                        <Badge color="green" leftSection={<IconShieldCheck size={11} />}>
                          Enrolled
                        </Badge>
                      ) : (
                        <Tooltip label={mfaRequired ? 'Will be asked to enrol at next sign-in' : 'Not enforced yet'}>
                          <Badge color={mfaRequired ? 'orange' : 'gray'}>Not enrolled</Badge>
                        </Tooltip>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="dot" color={m.active === false ? 'gray' : 'green'}>
                        {m.active === false ? 'Deactivated' : 'Active'}
                      </Badge>
                    </Table.Td>
                    <Table.Td className="tm-num">
                      <Text size="sm">{formatDate(m.meta?.lastUpdated?.slice(0, 10))}</Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Menu position="bottom-end">
                        <Menu.Target>
                          <Button size="xs" variant="subtle" color="gray" aria-label="More actions">
                            <IconDots size={16} />
                          </Button>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item disabled={!user?.mfaEnrolled} onClick={() => resetMfa(m)}>
                            Reset two-factor (lost device)
                          </Menu.Item>
                          {m.active === false ? (
                            <Menu.Item onClick={() => update(m, { active: true }, 'User reactivated.')}>Reactivate</Menu.Item>
                          ) : (
                            <Menu.Item color="red" onClick={() => update(m, { active: false }, 'User deactivated. They can no longer sign in to this practice.')}>
                              Deactivate
                            </Menu.Item>
                          )}
                        </Menu.Dropdown>
                      </Menu>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Section>
      <Text size="xs" c="dimmed" mt="sm">
        Record quarterly access reviews as attestations in Audit & compliance. External-biller access with an expiry date is set when the billing decision (D5) is made.
      </Text>
      {inviting && data.data && <InviteModal roles={data.data.roles} projectId={projectId} onClose={() => setInviting(false)} onSaved={() => { setInviting(false); data.reload(); }} />}
    </PageBody>
  );
}

function InviteModal({ roles, projectId, onClose, onSaved }: { readonly roles: AccessPolicy[]; readonly projectId: string; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [error, setError] = useState<string>();
  const form = useForm({
    initialValues: { firstName: '', lastName: '', email: '', role: roles[0]?.id ?? '', password: '' },
    validate: {
      firstName: (v) => (v.trim() ? null : 'Required'),
      lastName: (v) => (v.trim() ? null : 'Required'),
      email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? null : 'Enter a valid email'),
      role: (v) => (v ? null : 'Choose a role'),
      password: (v) => (v && v.length < 8 ? 'At least 8 characters' : null),
    },
  });
  const save = async (v: typeof form.values): Promise<void> => {
    const policy = roles.find((r) => r.id === v.role);
    try {
      await medplum.post(`admin/projects/${projectId}/invite`, {
        resourceType: 'Practitioner',
        firstName: v.firstName.trim(),
        lastName: v.lastName.trim(),
        email: v.email.trim().toLowerCase(),
        password: v.password || undefined,
        sendEmail: !v.password,
        scope: 'server',
        membership: v.role === ADMIN ? { admin: true } : { accessPolicy: policy ? { reference: getReferenceString(policy), display: policy.name } : undefined },
      });
      notifications.show({ color: 'brand', message: `${v.firstName} invited.` });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };
  return (
    <Modal opened onClose={onClose} title="Invite user" centered>
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          {error && <Alert color="red">{error}</Alert>}
          <SimpleGrid cols={2}>
            <TextInput label="First name" required {...form.getInputProps('firstName')} />
            <TextInput label="Last name" required {...form.getInputProps('lastName')} />
          </SimpleGrid>
          <TextInput label="Work email" required {...form.getInputProps('email')} />
          <Select label="Role" required data={[...roles.map((r) => ({ value: r.id as string, label: r.name?.replace(ROLE_POLICY_PREFIX, '') as string })), { value: ADMIN, label: 'Administrator' }]} {...form.getInputProps('role')} />
          <PasswordInput label="Temporary password" description="Local and staging only. In production leave blank: the user gets an email to set their own." {...form.getInputProps('password')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Invite</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
