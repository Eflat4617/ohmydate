import { ApiError, apiErrorFromResponse, parseProblem } from '../src/api/errors';

function problemResponse(
  body: unknown,
  status: number,
  contentType = 'application/problem+json',
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  });
}

describe('problem+json parsing', () => {
  it('parses a well-formed problem into a typed ApiError', async () => {
    const error = await apiErrorFromResponse(
      problemResponse(
        {
          type: 'about:blank',
          title: 'Version precondition failed',
          status: 412,
          code: 'version_conflict',
          detail: 'Server version is 3',
          traceId: 'trace-1',
        },
        412,
      ),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(412);
    expect(error.code).toBe('version_conflict');
    expect(error.detail).toBe('Server version is 3');
    expect(error.problem?.traceId).toBe('trace-1');
  });

  it('falls back to detail=title when detail is missing', async () => {
    const error = await apiErrorFromResponse(
      problemResponse(
        { type: 'about:blank', title: 'Not found', status: 404, code: 'not_found' },
        404,
      ),
    );

    expect(error.code).toBe('not_found');
    expect(error.detail).toBe('Not found');
  });

  it('does not trust an unknown code or malformed body', async () => {
    expect(parseProblem({ title: 'x', status: 400, code: 'made_up' })).toBeNull();
    expect(
      parseProblem({ type: 'about:blank', title: 'x', status: 400, code: 'validation_failed' }),
    ).not.toBeNull();

    const error = await apiErrorFromResponse(problemResponse('not json', 500, 'text/plain'));
    expect(error.status).toBe(500);
    expect(error.code).toBe('unknown');
    expect(error.detail).toBe('Request failed with status 500');
  });
});
