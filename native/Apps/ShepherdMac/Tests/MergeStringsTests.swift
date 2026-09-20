import Testing
@testable import Shepherd
struct MergeStringsTests {
    @Test func nativeLabelsResolve() {
        #expect(L.t("native_merge_overview") != "native_merge_overview")
        #expect(L.t("mergeconfirm_review_block", "reviewer") != "mergeconfirm_review_block")
    }
}
