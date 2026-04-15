## Description

<!-- Provide a clear and concise description of what this PR does -->

### Type of Change

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] 📚 Documentation
- [ ] ♻️ Refactoring
- [ ] ⚡ Performance improvement
- [ ] 🔒 Security fix
- [ ] 🧪 Test coverage
- [ ] 🔧 Configuration/tooling

## Related Issues

<!-- Link to related issues: Closes #123, Relates to #456 -->

Closes:

## Testing

### Test Coverage

- [ ] Added/updated unit tests
- [ ] Added/updated integration tests
- [ ] Benchmark validation (if performance-critical)
- [ ] All tests pass locally: `nx run-many -t test`

### Manual Testing Steps

<!-- Describe steps to manually verify the changes -->

1.
2.
3.

## Checklist

### Code Quality

- [ ] Lint passes: `nx run-many -t lint`
- [ ] Format passes: `nx run-many -t format`
- [ ] Code follows Atmos patterns (zero-alloc, adaptive safety)
- [ ] English-only identifiers and comments

### Documentation

- [ ] Updated README or docs if needed
- [ ] Added code comments for complex logic
- [ ] Commit messages follow conventional commits

### Performance

- [ ] Benchmarks maintained/improved
- [ ] No unexpected allocations in hot paths
- [ ] Verified zero-allocation claims (if applicable)

### Security

- [ ] No secrets or credentials committed
- [ ] No unsafe patterns without documented justification
- [ ] Dependencies reviewed for vulnerabilities

## Reviewers

<!-- Optional: mention specific reviewers -->

/cc @maintainers

## Additional Context

<!-- Add any other context about the PR -->

---

**CI Status**: The PR will automatically run:

- Leak detection (Gitleaks)
- Format verification (Dprint)
- Lint checks (GolangCI-Lint)
- Tests (all packages)
- Website validation (Docusaurus)
- Benchmarks (performance validation)
- Security analysis (CodeQL + Scorecard)
