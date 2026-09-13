# Mosaic benchmark

Executa SkillsBench com scripts/mosaic-e2e.

```sh
npx nx run mosaic-benchmark:run -- setup
npx nx run mosaic-benchmark:run -- list
npx nx run mosaic-benchmark:run -- oracle --task jax-computing-basics
npx nx run mosaic-benchmark:run -- prepare --task jax-computing-basics
npx nx run mosaic-benchmark:run -- run --task jax-computing-basics --yes-paid-run
```

Repita --task para executar um subconjunto. Resultados ficam em benchmarks/mosaic/results/<uuid>/. Veja [o harness compartilhado](../harness/README.md).
