# Tooling Instructions

- Tools are repository infrastructure; changes must preserve normal repository bootstrap and developer workflows.
- Prefer existing repository tooling and configuration over introducing another mechanism.
- Tooling must be deterministic, repository-root aware, and safe to run repeatedly.
- Do not make repository tooling modify source behavior as a side effect unless explicitly required by the command.
