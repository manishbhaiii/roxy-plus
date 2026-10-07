# Kaizen

A clean, modern Discord account dashboard for connecting multiple accounts through a browser UI.

## Run on Termux

```bash
pkg update
pkg install nodejs-lts
cd ~/roxy-plus
npm install
npm start
```

Open this address in Chrome on the same Android device:

```text
http://127.0.0.1:3000
```

The dashboard listens only on the local device. Do not expose the token form to a public network.

## Notes

- No `.env` file or environment configuration is required.
- The app uses only the dependencies needed by the current dashboard entry point.
