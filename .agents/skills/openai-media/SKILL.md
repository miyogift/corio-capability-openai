---
name: openai-media
description: Invoke this installed package's OpenAI-compatible image, speech and video operations through the Corio CLI.
---

Use the enabled Agent plugin connection shown by `corio capability list`. Choose exact provider/model/protocol IDs. Authentication is supplied by Manager; do not include credentials in parameters.

Read `corio image generate --help`, `corio speech synthesize --help` or `corio video generate --help`. Pass prompts/text in files, and extension-specific options in `--params-file`. Image `quality`, `background`, `output_compression`, and speech `instructions` are examples; available values depend on the actual model and endpoint. Do not classify executors or models by fixed task specialties.

Width/height must both be present. Standard fields are translated to native `size`, `n`, `output_format`, `response_format` or `seconds`; do not duplicate those fields in params. For unsupported multipart file/streaming requirements, report the limitation instead of silently changing the request.

Video submit returns a local jobId and providerJobId. Query with `corio capability job get <jobId>` or bounded `wait`; never submit generation again because a query timed out. An unknown cancellation means the provider may continue to work and charge.

Artifacts are local paths. Use `corio file upload` to publish a completed file, then explicitly use `corio group send` with its attachment when delivery is useful. A generated artifact or native response alone is not a group message.
