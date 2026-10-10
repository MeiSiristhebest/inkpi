# @inkpi/ai

Use the package root for provider streams, images, OAuth, and other runtime adapters:

```ts
import { streamAi } from '@inkpi/ai';
```

Use the lightweight `models` subpath when a client only needs model metadata, catalog helpers, or built-in presets:

```ts
import { KNOWN_MODELS, findModelInCatalog, getModelPreset } from '@inkpi/ai/models';

const model = findModelInCatalog('gpt-4o');
const preset = getModelPreset('creative-fast');
```

The `models` entry does not load provider transports, image generation, OAuth, or stream adapters. It includes the generated model catalog, catalog conversion and lookup helpers, and static presets.
