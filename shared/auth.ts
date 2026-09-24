export interface PasswordParameters {
  algorithm: "argon2id";
  salt: string;
  iterations: number;
  memorySize: number;
  parallelism: number;
  hashLength: number;
}
