// src/config/firebase.js
// Firebase has been removed from the backend presence system.
// Keep a no-op shim to avoid breaking legacy imports.

const initializeFirebase = () => null;
const getFirebaseDatabase = () => null;

module.exports = { initializeFirebase, getFirebaseDatabase };
