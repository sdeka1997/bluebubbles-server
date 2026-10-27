import React, { useState, useEffect, useCallback } from 'react';
import { FormControl, FormHelperText, Text, Box, Stack, Button, Badge, HStack, Link } from '@chakra-ui/react';
import { getFindMyKeysStatus, importFindMyKeys } from '../../utils/IpcUtils';
import { findMyKeysCardView, findMyKeysImportOutcome, FindMyKeysStatusResponse } from '../../utils/FindMyKeysUtils';
import { showSuccessToast, showErrorToast } from '../../utils/ToastUtils';

export const FindMyKeysField = (): JSX.Element => {
    const [statusResponse, setStatusResponse] = useState(null as FindMyKeysStatusResponse | null);
    const [importing, setImporting] = useState(false);

    const refreshStatus = useCallback(async () => {
        try {
            setStatusResponse(await getFindMyKeysStatus());
        } catch {
            setStatusResponse(null);
        }
    }, []);

    useEffect(() => {
        refreshStatus();
    }, [refreshStatus]);

    // Only shown on macOS 14.4+, where Apple encrypts the Find My cache
    const view = findMyKeysCardView(statusResponse);
    if (!view.visible) return <></>;

    const onImport = async () => {
        setImporting(true);
        try {
            const outcome = findMyKeysImportOutcome(await importFindMyKeys());
            if (outcome.toast?.kind === 'success') showSuccessToast({ description: outcome.toast.message });
            if (outcome.toast?.kind === 'error') showErrorToast({ description: outcome.toast.message });
            if (outcome.refresh) await refreshStatus();
        } catch {
            showErrorToast({ description: 'Failed to import the Find My keys.' });
        } finally {
            setImporting(false);
        }
    };

    return (
        <Box mt={3}>
            <Text fontSize='md' fontWeight='bold'>Find My Decryption Keys</Text>
            <FormControl mt={2}>
                <Text fontSize='sm' mb={2}>{view.summary}</Text>
                <Stack direction='column' maxWidth='32em' spacing={1}>
                    {view.rows.map(row => (
                        <HStack key={row.label} justifyContent='space-between' width='100%'>
                            <Text fontSize='sm'>{row.label}</Text>
                            <Badge colorScheme={row.color}>{row.badge}</Badge>
                        </HStack>
                    ))}
                </Stack>
                <Button size='xs' mt={3} onClick={onImport} isLoading={importing}>
                    Import Keys from Folder
                </Button>
                <FormHelperText>
                    <Text>
                        On macOS 14.4+, Apple encrypts the Find My location cache. BlueBubbles needs three
                        decryption keys to read device and friend locations.
                    </Text>
                    <Text mt={2}>
                        Getting the keys is a one-time step you do yourself on this Mac, outside BlueBubbles,
                        with a tool such as{' '}
                        <Link
                            color='blue.500'
                            target='_blank'
                            href='https://github.com/manonstreet/findmy-key-extractor'
                        >
                            findmy-key-extractor
                        </Link>
                        . That tool requires temporarily disabling System Integrity Protection (SIP) and AMFI.
                        Re-enable SIP and AMFI as soon as the keys are extracted.
                    </Text>
                    <Text mt={2}>
                        Then click the button above and select the folder that contains LocalStorage.key,
                        FMIPDataManager.bplist, and FMFDataManager.bplist. All three are imported together:
                        if any one is missing or invalid, nothing is imported and your previous keys are
                        kept. The keys survive reboots, so you only need to do this once.
                    </Text>
                </FormHelperText>
            </FormControl>
        </Box>
    );
};
