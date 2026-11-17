import type AsyncStorage from '@react-native-async-storage/async-storage';
import type { Persistence } from 'firebase/auth';

declare module 'firebase/auth' {
  // The React Native conditional export exists at runtime; the package's
  // platform-neutral barrel omits this function from its declaration file.
  export function getReactNativePersistence(storage: typeof AsyncStorage): Persistence;
}
