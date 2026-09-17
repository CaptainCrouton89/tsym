const key = 'method';
type Result = number;
class Example {
  [key](): Result { return 1; }
}
