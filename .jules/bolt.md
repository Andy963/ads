## 2024-05-24 - Array backwards search optimization
**Learning:** Found multiple instances of `[...array].reverse().find()` being used for array backwards searching. This is an anti-pattern as it causes an O(N) memory allocation and array mutation before performing the search.
**Action:** Replaced instances of `[...array].reverse().find()` with the native ES2023 `array.findLast()` method to avoid unnecessary memory allocations.
