import { describe, expect, test, vi } from 'vitest';
import { persistTokenState, previousTokenWarning } from './setup.mjs';

function deps(overrides = {}) {
  return {
    writeTokenFile: vi.fn(async () => undefined),
    writeTokenMetadata: vi.fn(async () => undefined),
    deleteToken: vi.fn(async () => true),
    ...overrides,
  };
}

describe('token rotation warnings', () => {
  test('warns when a rotation cannot identify the previous token id', () => {
    const message = previousTokenWarning(true, null);
    expect(message).toContain('이전 Vikunja 토큰 id 를 확인하지 못해');
    expect(message).toContain('Vikunja 설정의 API 토큰');
  });

  test('does not warn for a known id or when nothing was rotated', () => {
    expect(previousTokenWarning(true, 7)).toBeNull();
    expect(previousTokenWarning(false, null)).toBeNull();
  });
});

describe('persistTokenState', () => {
  test('writes the token file and metadata on success', async () => {
    const io = deps();
    await persistTokenState({
      tokenCreated: true,
      tokenFileExisted: true,
      metadataExisted: true,
      tokenId: 9,
      ...io,
    });
    expect(io.writeTokenFile).toHaveBeenCalledTimes(1);
    expect(io.writeTokenMetadata).toHaveBeenCalledTimes(1);
    expect(io.deleteToken).not.toHaveBeenCalled();
  });

  test('does not revoke the new token when the token file was already replaced', async () => {
    const io = deps({
      writeTokenMetadata: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    await expect(
      persistTokenState({
        tokenCreated: true,
        tokenFileExisted: true,
        metadataExisted: false,
        tokenId: 9,
        ...io,
      }),
    ).rejects.toThrow('Vikunja 토큰 파일을 저장하지 못했습니다');
    expect(io.writeTokenFile).toHaveBeenCalledTimes(1);
    expect(io.deleteToken).not.toHaveBeenCalled();
  });

  test('revokes an unrecorded new token when the token file write fails', async () => {
    const io = deps({
      writeTokenFile: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    });
    await expect(
      persistTokenState({
        tokenCreated: true,
        tokenFileExisted: true,
        metadataExisted: false,
        tokenId: 9,
        ...io,
      }),
    ).rejects.toThrow('Vikunja 토큰 파일을 저장하지 못했습니다');
    expect(io.writeTokenMetadata).not.toHaveBeenCalled();
    expect(io.deleteToken).toHaveBeenCalledWith(9);
  });

  test('a metadata-only failure never revokes an existing token', async () => {
    const io = deps({
      writeTokenMetadata: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    });
    await expect(
      persistTokenState({
        tokenCreated: false,
        tokenFileExisted: true,
        metadataExisted: false,
        tokenId: 9,
        ...io,
      }),
    ).rejects.toThrow('Vikunja 토큰 파일을 저장하지 못했습니다');
    expect(io.writeTokenFile).not.toHaveBeenCalled();
    expect(io.deleteToken).not.toHaveBeenCalled();
  });
});
