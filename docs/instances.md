# Poney instances talking to each other

Not built. Bob opens his Poney as a server and chooses what he shares (models,
projects). Alice adds it to her providers and can use Bob's models on her own
projects, her models on Bob's projects, or Bob's models on Bob's projects.

So a model and a project are independent. What is ready for it, and nothing more:

- A provider has a stable `id` and a `type` (`src/providers.js`): "Poney distant"
  would be one more type, and a conversation already names its provider.
- The queue and the models live in a service (`src/engine/`), not in conversations:
  a call from another instance would enter by `ModelEngine.acquire` like a local one.
- The engine stays behind its own local API, one key per model, on 127.0.0.1.

What is left to decide then: tools must run where the project is, while the model
may be elsewhere, so a conversation will need a project location as it has a
provider. Sharing, authentication and transport do not exist yet: nothing listens
on the network.
