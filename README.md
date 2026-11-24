<div align="center">
  <h1>German AI Teacher</h1>
  <p>A voice-first AI German teacher for people living in Germany.</p>
  <p>
    <img src="https://img.shields.io/badge/Expo_SDK-58-000?logo=expo&logoColor=fff" alt="Expo SDK 58">
    <img src="https://img.shields.io/badge/LiveKit-Agents-000?logo=livekit&logoColor=fff" alt="LiveKit Agents">
    <img src="https://img.shields.io/badge/license-MIT-000" alt="MIT license">
  </p>
</div>

## Why I'm building this

I'm a data center technician in Frankfurt, and my German is at A1.2. I'm building the teacher I need: one I can talk to, about the real situations of life in Germany.

I'm building it in public on X and LinkedIn.

## Demo

<!-- TODO: add a demo GIF, for example assets/demo.gif -->

_A demo GIF is coming soon._

## Tech stack

- [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/) for iOS and Android
- [Expo Router](https://docs.expo.dev/router/introduction/), which also serves the LiveKit token endpoint as an API route
- [LiveKit Agents](https://docs.livekit.io/agents/) in TypeScript for the voice agent
- Realtime speech-to-speech through [LiveKit Inference](https://docs.livekit.io/agents/models/), so you need no separate OpenAI key

## Quick start

You need Node.js 22.13 or newer, Xcode or Android Studio, and the [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) with a free [LiveKit Cloud](https://cloud.livekit.io) project.

```sh
npm install
npm --prefix agent install
lk cloud auth
lk app env -w
```

`lk app env -w` writes your LiveKit credentials to `.env.local`. This file is ignored by Git. See `.env.example` for the variable names.

Start the agent and the app in two terminals:

```sh
npm run agent
```

```sh
npm run ios
```

For Android, use `npm run android`. The app needs a development build, because Expo Go does not include WebRTC.

On a simulator or emulator, the agent can hear its own voice from your speakers. Mute the microphone while the agent speaks.

> **Current state:** `agent/agent.ts` is still a Spanish-speaking restaurant reservation agent from an earlier experiment. "Lena", the German teacher, replaces it next.

## Roadmap

- [ ] Teacher agent: Lena, a patient German teacher for levels A1 to B1
- [ ] Scenarios: real situations in Germany, for example the doctor, the Bürgeramt, the landlord and the supermarket
- [ ] Mistake tracking: remember your mistakes and practice them again
- [ ] Onboarding: native language (Spanish or English), level and goals
- [ ] Supabase auth: accounts and a protected token endpoint
- [ ] Spaced repetition: review words and phrases at the right time
- [ ] Beta: TestFlight and Google Play internal testing
- [ ] Subscriptions on iOS and Android

## Credits

This project is built on [expo/expo-livekit-template](https://github.com/expo/expo-livekit-template) (MIT). The audio visualizers come from [LiveKit Agents UI](src/components/agents-ui/README.md) (Apache 2.0).

## License

[MIT](LICENSE)
