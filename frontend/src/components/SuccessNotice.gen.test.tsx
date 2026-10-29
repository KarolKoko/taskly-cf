import { describe, test, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { SuccessNotice } from './SuccessNotice';

vi.mock("../design-system", () => import("../design-system/mocks"));

// Generated from the code, frontend rules and sampled DB rows - review before committing. Jest APIs used:
//   test(name, fn, timeout) - https://jestjs.io/docs/api#testname-fn-timeout
//   describe(name, fn) - https://jestjs.io/docs/api#describename-fn

describe("SuccessNotice", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  test("renders nothing when !message", () => {
    const message = "";
    const { container } = render(<SuccessNotice message={message} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("renders when message", () => {
    const message = "Sample message";
    const { container } = render(<SuccessNotice message={message} />);
    expect(container).not.toBeEmptyDOMElement();
    expect(container).toHaveTextContent(message);
  });
});
