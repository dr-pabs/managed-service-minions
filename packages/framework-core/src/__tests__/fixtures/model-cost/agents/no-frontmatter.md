# No Frontmatter (fixture)

This agent file has no leading YAML frontmatter block at all, so
`readAgentFrontmatter` should record it with no `minionType`, and
`buildMinionTypeToTierMap` must skip it without throwing.
