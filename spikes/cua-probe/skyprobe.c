// Capability probe: are the private SkyLight symbols cua-driver relies on
// actually resolvable at runtime on THIS macOS build? Read-only; loads only.
#include <dlfcn.h>
#include <stdio.h>
int main(void) {
    const char *path = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight";
    void *h = dlopen(path, RTLD_LAZY | RTLD_GLOBAL);
    printf("dlopen(SkyLight) = %s\n", h ? "OK" : dlerror());
    const char *syms[] = {
        "SLEventPostToPid", "SLEventSetAuthenticationMessage", "SLEventSetIntegerValueField",
        "CGEventSetWindowLocation", "SLPSPostEventRecordTo", "SLPSSetFrontProcessWithOptions",
        "_SLPSGetFrontProcess", "GetProcessForPID", "SLPSGetWindowOwner", "SLSGetConnectionPSN",
        "CGSMainConnectionID", "SLSGetActiveSpace", "SLSCopySpacesForWindows",
        "SLSCopyManagedDisplayForWindow", "SLSManagedDisplayGetCurrentSpace", NULL };
    int missing = 0;
    for (int i = 0; syms[i]; i++) {
        void *p = dlsym(RTLD_DEFAULT, syms[i]);
        printf("  %-36s %s\n", syms[i], p ? "resolved" : "MISSING");
        if (!p) missing++;
    }
    printf("missing=%d\n", missing);
    return 0;
}
