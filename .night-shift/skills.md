# Installed skills

These skills are installed here as committed copies. They are not fetched at run
time: an upstream edit would otherwise change what an unattended run does
without anyone reviewing it, and a network install adds a failure mode at
whatever hour the run wakes.

| Skill | Source | Upstream commit |
|---|---|---|
| `night-shift-worker` | `factoryengineering/skills` | `2fb85d8297c0a3059365bd809b8242f5657f2740` |
| `refining-issues` | `factoryengineering/skills` | `2fb85d8297c0a3059365bd809b8242f5657f2740` |
| `night-shift-setup` | `factoryengineering/skills` | `2fb85d8297c0a3059365bd809b8242f5657f2740` |

To take an upstream change, re-copy the skill directory from its source, update
its commit above, and read the diff before you push. Local edits to an installed
skill belong upstream instead, or the next update silently reverts them.
