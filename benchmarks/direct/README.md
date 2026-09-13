# Direct benchmark

Executa SkillsBench com scripts/direct-skills-e2e.

```sh
npx nx run direct-benchmark:run -- setup
npx nx run direct-benchmark:run -- list
npx nx run direct-benchmark:run -- oracle --task jax-computing-basics
npx nx run direct-benchmark:run -- prepare --task jax-computing-basics
npx nx run direct-benchmark:run -- run --task jax-computing-basics --yes-paid-run
```

Repita --task para executar um subconjunto. Resultados ficam em benchmarks/direct/results/<uuid>/. Veja [o harness compartilhado](../harness/README.md).
