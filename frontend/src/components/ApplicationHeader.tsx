import { AppHeader, Heading, Text } from '../design-system'

export function ApplicationHeader() {
  return (
    <AppHeader>
      <a href="/" aria-label="Taskly App Node — home">
        <Heading level={2}>Taskly App Node</Heading>
      </a>
      <Text muted>Task list</Text>
    </AppHeader>
  )
}
