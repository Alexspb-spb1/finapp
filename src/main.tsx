import './bootstrap/inviteTokenBootstrap'

// No static application dependencies: bootstrap must finish before React,
// Firebase, styles or any application observer can evaluate.
void import('./renderApp')
