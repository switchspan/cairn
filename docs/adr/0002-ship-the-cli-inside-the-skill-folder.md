# Ship the CLI inside the skill folder

Every target host reads the same SKILL.md format and tells the agent where the
skill's folder is, but only Claude Code puts a plugin's `bin/` on `PATH`. The
built CLI is therefore committed under `skills/checkpoint/scripts/`, and each
adapter's hooks and skill run it from there. No host needs a global npm
install, `npx`, or a prebuilt binary. `npm test` fails when the committed build
differs from a fresh build. The cost is committed build output and one copy of
the CLI per installed skill. Moving the CLI later would mean migrating every
user's hook configuration in every host.
