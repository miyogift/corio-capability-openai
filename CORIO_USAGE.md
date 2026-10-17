# OpenAI media plugin

This plugin provides `image.generate`, `speech.synthesize` and `video.generate` through
OpenAI-compatible endpoints. Use the connection ID shown in the Corio plugin Skill.
Manager injects the connection configuration; never supply API keys in a command or prompt.

## Image generation

```sh
corio image generate --connection <connection-id> --prompt-file prompt.md --width 1024 --height 1024 --params-file options.json
```

Both dimensions must be supplied together. Optional common fields include `count` and
`format` (`png`, `jpeg`, `webp`). Provider options such as `quality` belong in the params
object. The model comes from connection `imageModel`, or an explicit `params.model`.
Image streaming is not supported by this plugin.

## Speech synthesis

```sh
corio speech synthesize --connection <connection-id> --text-file speech.md --voice alloy --format mp3
```

The model comes from connection `speechModel`, or `params.model`. Common fields include
voice, format and speed; model-specific instructions belong in params. Formats include
mp3, opus, aac, flac, wav and pcm. This generates a file; it does not enable meeting playback.

## Video generation

```sh
corio video generate --connection <connection-id> --prompt-file prompt.md --duration 4
corio capability job wait <job-id> --json '{"seconds":30}'
```

The model comes from connection `videoModel`, or `params.model`. Video is asynchronous;
query or wait for the returned job. Do not submit again because a request timed out.
Video request params currently accept scalar fields; input-file multipart options are
unsupported. Cancellation may be unavailable and must not be treated as confirmed.

## Deliver results

Results contain artifact paths. Explicitly upload a generated artifact with
`corio file upload`, then reference the uploaded file in `corio group send` or a library
command. Generation alone does not send a message or publish a library file.
